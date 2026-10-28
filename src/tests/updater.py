import importlib.util
import argparse
from contextlib import redirect_stderr, redirect_stdout
import fcntl
import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import tarfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater', Path(__file__).parents[1] / 'worker/updater.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
CONFIG = {'repository': 'https://github.com/Pingoose-42/pingoose_42_extension_main', 'branch': 'main'}
A, B = 'a' * 40, 'b' * 40


def source_archive(entries=None, sha=B):
    output = io.BytesIO()
    prefix = 'pingoose_42_extension_main-' + sha
    if entries is None:
        entries = [('src/scripts/install.sh', ':\n')]
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, content in entries:
            member = tarfile.TarInfo(name if name.startswith('/') else prefix + '/' + name)
            if isinstance(content, str):
                data = content.encode()
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            else:
                member.type = content
                member.linkname = '/tmp/pingoose-target'
                archive.addfile(member)
    return output.getvalue()


class Updates(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'state.json'
        self.state = {'source': CONFIG, 'installed': {'sha': A}, 'baseline': {'sha': A}}
        self.sha = A
        self.comparison = 'ahead'
        self.requests = []

    def api(self, config, route):
        self.requests.append(route)
        if route.startswith('compare/'):
            return {'status': self.comparison}
        return {'sha': self.sha, 'commit': {'message': 'Update\nDetails', 'committer': {'date': '2026-10-21T00:00:00Z'}}}

    def check(self, login):
        return updater.check(CONFIG, self.state, self.path, login, self.api)

    def available(self):
        self.assertEqual(self.check('session1')['status'], 'current')
        self.sha = B
        self.assertEqual(self.check('session2')['status'], 'available')

    def test_once_per_session_and_decline_keeps_baseline(self):
        self.available()
        self.assertEqual(self.check('session2')['status'], 'skipped')
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(self.state['baseline']['sha'], A)
        self.assertEqual(self.check('session3')['status'], 'available')

    def test_manual_check_bypasses_session_limit(self):
        self.check('session1')
        self.sha = B
        self.assertEqual(self.check('session1')['status'], 'skipped')
        result = updater.check(CONFIG, self.state, self.path, 'session1', self.api, force=True)
        self.assertEqual(result['status'], 'available')

    def test_rewind_or_identical_is_not_a_newer_commit(self):
        self.check('session1')
        self.sha = B
        for index, status in enumerate(['behind', 'identical']):
            self.comparison = status
            self.assertEqual(self.check(str(index))['status'], 'current')

    def test_network_failure_does_not_advance_baseline(self):
        self.check('session1')
        with self.assertRaises(OSError):
            updater.check(CONFIG, self.state, self.path, 'session2', lambda *_: (_ for _ in ()).throw(OSError()))
        self.assertEqual(self.state['baseline']['sha'], A)
        self.assertEqual(self.check('session2')['status'], 'skipped')

    def fetch(self, config, sha, destination):
        (destination / 'src/scripts').mkdir(parents=True)
        (destination / 'src/scripts/install.sh').write_text(':\n')

    def test_installs_approved_archive_and_records_source(self):
        self.available()
        calls = []
        def run(args, cwd=None, timeout=None):
            calls.append(args)
            source = Path(cwd)
            self.assertEqual(updater.source_receipt(source / 'src'), {'source': CONFIG, 'sha': B})
        fetches = []
        def fetch(config, sha, destination):
            fetches.append((config, sha))
            self.fetch(config, sha, destination)
        result = updater.install(CONFIG, self.state, self.path, B, run, fetch)
        self.assertEqual(result['status'], 'installed')
        self.assertEqual(fetches, [(CONFIG, B)])
        self.assertEqual(calls, [['bash', './src/scripts/install.sh']])
        self.assertEqual(self.state['baseline']['sha'], B)
        self.assertFalse(list(self.path.parent.glob('source-*')))

    def test_failed_install_keeps_state_and_cleans_source(self):
        self.available()
        before = self.path.read_text()
        def run(args, **kwargs):
            raise updater.UpdateError('fixture failed')
        with self.assertRaises(updater.UpdateError):
            updater.install(CONFIG, self.state, self.path, B, run, self.fetch)
        self.assertEqual(self.state['baseline']['sha'], A)
        self.assertEqual(self.path.read_text(), before)
        self.assertFalse(list(self.path.parent.glob('source-*')))

    def test_failed_download_keeps_state_and_cleans_source(self):
        self.available()
        before = self.path.read_text()
        def fetch(config, sha, destination):
            destination.mkdir()
            raise updater.UpdateError('download failed')
        with self.assertRaises(updater.UpdateError):
            updater.install(CONFIG, self.state, self.path, B,
                            lambda *_: self.fail('must not install'), fetch)
        self.assertEqual(self.path.read_text(), before)
        self.assertFalse(list(self.path.parent.glob('source-*')))

    def test_rejects_changed_source_or_unapproved_commit(self):
        self.available()
        for config, sha in [(CONFIG, A), ({**CONFIG, 'branch': 'other'}, B)]:
            with self.assertRaises(updater.UpdateError):
                updater.install(config, self.state, self.path, sha, lambda *_: self.fail('must not execute'))

    def test_repository_change_offers_configured_branch(self):
        self.available()
        result = updater.check({**CONFIG, 'branch': 'next'}, self.state, self.path, 'session3', self.api)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(self.state['candidate']['sha'], B)

    def test_legacy_remote_baseline_does_not_hide_update(self):
        self.state = {'source': CONFIG, 'baseline': {'sha': B}}
        self.sha = B
        self.assertEqual(self.check('session1')['status'], 'available')

    def test_install_receipt_overrides_stale_state(self):
        self.sha = B
        result = updater.check(CONFIG, self.state, self.path, 'session1', self.api,
                               installed={'source': CONFIG, 'sha': B})
        self.assertEqual(result['status'], 'current')
        self.assertEqual(self.requests, ['commits/main'])

    def test_first_check_compares_actual_install(self):
        self.state = {}
        self.sha = B
        result = updater.check(CONFIG, self.state, self.path, 'session1', self.api,
                               installed={'source': CONFIG, 'sha': A})
        self.assertEqual(result['status'], 'available')
        self.assertIn(f'compare/{A}...{B}', self.requests)

    def test_diverged_branch_offers_update(self):
        self.sha = B
        self.comparison = 'diverged'
        self.assertEqual(self.check('session1')['status'], 'available')

    def test_branch_movement_does_not_change_installed_revision(self):
        self.available()
        self.sha = 'c' * 40
        payload = source_archive(entries=[('src/scripts/install.sh',
            'printf approved > ../../installed-fixture\n')])
        requests = []
        def open_url(request, **kwargs):
            requests.append(request.full_url)
            return io.BytesIO(payload)
        def fetch(config, sha, destination):
            updater.download_source(config, sha, destination, open_url)
        updater.install(CONFIG, self.state, self.path, B, updater.run_command, fetch)
        self.assertEqual((self.path.parent / 'installed-fixture').read_text(), 'approved')
        self.assertEqual(requests, [f'https://codeload.github.com/Pingoose-42/pingoose_42_extension_main/tar.gz/{B}'])
        self.assertFalse(list(self.path.parent.glob('source-*')))

    def test_custom_update_source_is_saved_in_package_config(self):
        config = {**CONFIG, 'branch': 'stable'}
        self.state = {'source': config, 'candidate': {'sha': B}}
        def run(args, cwd=None, **kwargs):
            self.assertEqual(json.loads((Path(cwd) / 'src/config/update.json').read_text()), config)
        updater.install(config, self.state, self.path, B, run, self.fetch)

    def test_collects_paginated_commit_titles(self):
        commits = [{'sha': format(i, '040x'), 'commit': {'message': f'Change {i}\nDetails'}} for i in range(305)]
        def api(config, route):
            if route.startswith('commits/'):
                return {'sha': B, 'commit': {'message': 'Latest'}}
            if '?' not in route:
                return {'status': 'ahead', 'commits': commits[:250], 'total_commits': 305}
            page = int(route.split('page=')[-1])
            return {'commits': commits[(page-1)*100:page*100]}
        updater.check(CONFIG, self.state, self.path, 'session1', api)
        changes = self.state['candidate']['changes']
        self.assertEqual(len(changes), 305)
        self.assertEqual(changes[-1]['message'], 'Change 304')
        self.assertEqual(self.state['installed']['sha'], A)

    def test_config_override(self):
        root = self.path.parent
        (root / 'config').mkdir()
        (root / 'config/update.json').write_text(json.dumps(CONFIG))
        with patch.dict('os.environ', {'XDG_CONFIG_HOME': str(root / 'user')}):
            self.assertEqual(updater.configuration(root), CONFIG)
            target = root / 'user/pingoose/update.json'
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps({**CONFIG, 'branch': 'stable'}))
            self.assertEqual(updater.configuration(root)['branch'], 'stable')
            target.write_text(json.dumps({**CONFIG, 'repository': 'https://other.example/repo'}))
            with self.assertRaises(updater.UpdateError):
                updater.configuration(root)


class SourceArchives(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def download(self, payload, sha=B):
        return updater.download_source(CONFIG, sha, self.root / 'source',
                                       lambda *a, **kw: io.BytesIO(payload))

    def test_extracts_source_without_git_metadata(self):
        self.download(source_archive())
        self.assertTrue((self.root / 'source/src/scripts/install.sh').is_file())
        self.assertFalse((self.root / 'source/.git').exists())

    def test_rejects_wrong_archive_revision(self):
        with self.assertRaises(updater.UpdateError):
            self.download(source_archive(sha=A))

    def test_rejects_paths_outside_source(self):
        for index, name in enumerate(['../../escaped', '../escaped', '/absolute', r'..\escaped']):
            with self.subTest(name=name), self.assertRaises(updater.UpdateError):
                updater.download_source(CONFIG, B, self.root / str(index),
                    lambda *a, **kw: io.BytesIO(source_archive([
                        ('src/scripts/install.sh', ':\n'), (name, 'unsafe')])))
        self.assertFalse((self.root / 'escaped').exists())

    def test_rejects_links_and_special_files(self):
        for index, kind in enumerate([tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]):
            with self.subTest(kind=kind), self.assertRaises(updater.UpdateError):
                updater.download_source(CONFIG, B, self.root / str(index),
                    lambda *a, **kw: io.BytesIO(source_archive([
                        ('src/scripts/install.sh', ':\n'), ('link', kind)])))

    def test_rejects_duplicate_files(self):
        with self.assertRaises(updater.UpdateError):
            self.download(source_archive([
                ('src/scripts/install.sh', ':\n'), ('duplicate', 'one'), ('duplicate', 'two')]))

    def test_rejects_damaged_archive(self):
        with self.assertRaises(updater.UpdateError):
            self.download(b'incomplete download')

    def test_requires_backend_installer(self):
        with self.assertRaises(updater.UpdateError):
            self.download(source_archive([('README.md', 'fixture')]))

    def test_limits_download_size(self):
        with patch.object(updater, 'MAX_ARCHIVE_BYTES', 10), self.assertRaises(updater.UpdateError):
            self.download(source_archive())

    def test_limits_extracted_size(self):
        with patch.object(updater, 'MAX_SOURCE_BYTES', 1), self.assertRaises(updater.UpdateError):
            self.download(source_archive())

    def test_limits_entry_count(self):
        with patch.object(updater, 'MAX_SOURCE_ENTRIES', 1), self.assertRaises(updater.UpdateError):
            self.download(source_archive([('src/scripts/install.sh', ':\n'), ('extra', '2')]))

    def test_archive_receipt_does_not_require_git(self):
        source = self.root / 'src'
        source.mkdir()
        (self.root / updater.SOURCE_RECEIPT).write_text(json.dumps({'source': CONFIG, 'sha': B}))
        with patch.object(subprocess, 'check_output', side_effect=AssertionError('must not run git')):
            self.assertEqual(updater.source_receipt(source), {'source': CONFIG, 'sha': B})

    def test_rejects_invalid_receipt_sha(self):
        source = self.root / 'src'
        source.mkdir()
        for sha in ['short', int('1' * 40), None]:
            with self.subTest(sha=sha), self.assertRaises(updater.UpdateError):
                (self.root / updater.SOURCE_RECEIPT).write_text(json.dumps({'source': CONFIG, 'sha': sha}))
                updater.source_receipt(source)

    def test_local_checkout_receipt_uses_git_revision(self):
        source = self.root / 'src'
        (source / 'config').mkdir(parents=True)
        (source / 'config/update.json').write_text(json.dumps(CONFIG))
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture',
                        '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        sha = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()
        with patch.dict(os.environ, {'XDG_CONFIG_HOME': str(self.root / 'absent')}):
            self.assertEqual(updater.source_receipt(source), {'source': CONFIG, 'sha': sha})

    def test_package_contains_archive_revision(self):
        source = self.root / 'src'
        (source / 'worker').mkdir(parents=True)
        (source / 'worker/updater.py').write_text(Path(updater.__file__).read_text())
        receipt = {'source': CONFIG, 'sha': B}
        (self.root / updater.SOURCE_RECEIPT).write_text(json.dumps(receipt))
        package = self.root / 'package.zip'
        with zipfile.ZipFile(package, 'w'):
            pass
        installer = Path(__file__).parents[1] / 'scripts/install.sh'
        code = installer.read_text().split("<<'PYRECEIPT'\n", 1)[1].split('\nPYRECEIPT', 1)[0]
        subprocess.run(['python3', '-', str(source), str(package)], input=code, text=True, check=True)
        with zipfile.ZipFile(package) as archive:
            self.assertEqual(json.loads(archive.read('config/installed.json')), receipt)

    def test_standalone_bootstrap_installs_and_cleans_source(self):
        helper = self.root / 'updater.py'
        helper.write_text(Path(updater.__file__).read_text())
        payload = self.root / 'source.tar.gz'
        payload.write_bytes(source_archive([('src/scripts/install.sh',
            'cp .pingoose-source.json ../../receipt.json\nprintf "Package installed\\n"\n')]))
        wrapper = '''
import io, pathlib, runpy, sys
from unittest.mock import patch
payload, helper = sys.argv[1:3]
sys.argv = sys.argv[2:]
with patch('urllib.request.urlopen', side_effect=lambda *a, **kw: io.BytesIO(pathlib.Path(payload).read_bytes())):
    runpy.run_path(helper, run_name='__main__')
'''
        result = subprocess.run(['python3', '-c', wrapper, str(payload), str(helper), 'bootstrap',
            '--repository', CONFIG['repository'], '--commit', B], text=True, capture_output=True,
            env=dict(os.environ, XDG_STATE_HOME=str(self.root / 'state')))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'Package installed\n')
        updates = self.root / 'state/pingoose/updates'
        self.assertEqual(json.loads((updates / 'receipt.json').read_text()), {'source': CONFIG, 'sha': B})
        self.assertFalse(list(updates.glob('source-*')))

    def test_bootstrap_uses_update_lock(self):
        updates = self.root / 'state/pingoose/updates'
        updates.mkdir(parents=True)
        with (updates / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(['python3', updater.__file__, 'bootstrap',
                '--repository', CONFIG['repository'], '--commit', B], text=True, capture_output=True,
                env=dict(os.environ, XDG_STATE_HOME=str(self.root / 'state')))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('Another installation or update is already running.', result.stderr)


class CommandOutput(unittest.TestCase):
    def test_gnome_actions_return_json(self):
        for action in ['check', 'install']:
            with self.subTest(action=action):
                stdout = io.StringIO()
                with patch.object(updater, 'parse_args', return_value=argparse.Namespace(action=action)), \
                        patch.object(updater, 'main', return_value={'status': 'current'}), redirect_stdout(stdout):
                    self.assertEqual(updater.cli(), 0)
                self.assertEqual(json.loads(stdout.getvalue()), {'status': 'current'})

    def test_gnome_errors_return_json(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(updater, 'parse_args', return_value=argparse.Namespace(action='install')), \
                patch.object(updater, 'main', side_effect=updater.UpdateError('fixture failure')), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(updater.cli(), 1)
        self.assertEqual(json.loads(stdout.getvalue()), {'status': 'error', 'error': 'fixture failure'})
        self.assertEqual(stderr.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
