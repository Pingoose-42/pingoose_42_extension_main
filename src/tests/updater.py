import importlib.util
import fcntl
import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater', Path(__file__).parents[1] / 'worker/updater.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
CONFIG = {'repository': 'https://github.com/Pingoose-42/pingoose_42_extension_main', 'branch': 'main'}
A, B = 'a' * 40, 'b' * 40


def fixture_source(config, sha, destination):
    (destination / 'src/scripts').mkdir(parents=True)
    (destination / 'src/scripts/install.sh').write_text('# fixture')


def source_archive(sha=B, entries=None):
    buffer = io.BytesIO()
    prefix = CONFIG['repository'].split('/')[-1] + '-' + sha
    entries = entries if entries is not None else [('src/scripts/install.sh', '# fixture')]
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, value in entries:
            member = tarfile.TarInfo(prefix + '/' + name)
            if isinstance(value, tarfile.TarInfo):
                member.type = value.type
                member.linkname = value.linkname
                archive.addfile(member)
            else:
                body = value.encode()
                member.size = len(body)
                member.mode = 0o755
                archive.addfile(member, io.BytesIO(body))
    return buffer.getvalue()


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

    def test_installs_exact_approved_commit_and_cleans_source(self):
        self.available()
        calls = []
        def run(args, cwd=None, timeout=None):
            calls.append(args)
            receipt = updater.source_receipt(Path(cwd) / 'src')
            self.assertEqual(receipt, {'source': CONFIG, 'sha': B})
        fetched = []
        def fetch(config, sha, destination):
            fetched.append((config, sha))
            fixture_source(config, sha, destination)
        result = updater.install(CONFIG, self.state, self.path, B, run, fetch)
        self.assertEqual(result['status'], 'installed')
        self.assertEqual(fetched, [(CONFIG, B)])
        self.assertEqual(calls, [['bash', './src/scripts/install.sh']])
        self.assertEqual(self.state['baseline']['sha'], B)
        self.assertFalse(list(self.path.parent.glob('source-*')))

    def test_failed_install_does_not_advance_and_cleans_source(self):
        self.available()
        def run(args, **kwargs):
            if args[0] == 'bash':
                raise updater.UpdateError('fixture failed')
        with self.assertRaises(updater.UpdateError):
            updater.install(CONFIG, self.state, self.path, B, run, fixture_source)
        self.assertEqual(self.state['baseline']['sha'], A)
        self.assertFalse(list(self.path.parent.glob('source-*')))

    def test_failed_download_does_not_run_or_advance(self):
        self.available()
        before = self.path.read_bytes()
        def fail(*args):
            raise updater.UpdateError('download failed')
        with self.assertRaises(updater.UpdateError):
            updater.install(CONFIG, self.state, self.path, B,
                            lambda *_a, **_kw: self.fail('must not execute'), fail)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.state['installed']['sha'], A)
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

    def test_real_archive_installs_pinned_revision_without_git(self):
        self.available()
        self.sha = 'c' * 40  # The branch moved after the update was approved.
        payload = source_archive(entries=[('src/scripts/install.sh',
            'printf approved > ../../installed-fixture\n'
            'cp .pingoose-source.json ../../installed-receipt.json\n')])
        urls = []
        def open_url(request, **kwargs):
            urls.append(request.full_url)
            return io.BytesIO(payload)
        def fetch(config, sha, destination):
            updater.download_source(config, sha, destination, open_url)
        updater.install(CONFIG, self.state, self.path, B, updater.run_command, fetch)
        self.assertEqual((self.path.parent / 'installed-fixture').read_text(), 'approved')
        self.assertEqual(json.loads((self.path.parent / 'installed-receipt.json').read_text()),
                         {'source': CONFIG, 'sha': B})
        self.assertEqual(urls, [f'https://codeload.github.com/Pingoose-42/pingoose_42_extension_main/tar.gz/{B}'])
        self.assertFalse(list(self.path.parent.glob('source-*')))

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


class Archives(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def download(self, payload):
        destination = self.root / 'source'
        updater.download_source(CONFIG, B, destination, lambda *_a, **_kw: io.BytesIO(payload))
        return destination

    def test_extracts_without_git(self):
        destination = self.download(source_archive())
        self.assertTrue((destination / 'src/scripts/install.sh').is_file())
        self.assertFalse((destination / '.git').exists())

    def test_rejects_paths_outside_archive_root(self):
        with self.assertRaises(updater.UpdateError):
            self.download(source_archive(entries=[('../outside', 'unsafe')]))
        self.assertFalse((self.root / 'outside').exists())

    def test_rejects_links(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE]:
            with self.subTest(kind=kind), self.assertRaises(updater.UpdateError):
                link = tarfile.TarInfo()
                link.type = kind
                link.linkname = '../outside'
                payload = source_archive(entries=[('link', link)])
                updater.download_source(CONFIG, B, self.root / kind.decode(),
                                        lambda *_a, **_kw: io.BytesIO(payload))

    def test_rejects_different_revision(self):
        with self.assertRaises(updater.UpdateError):
            self.download(source_archive(sha=A))

    def test_rejects_incomplete_or_invalid_archives(self):
        for payload in [b'not a gzip archive', source_archive(entries=[('README.md', 'no installer')])]:
            with self.subTest(payload=payload[:10]), self.assertRaises(updater.UpdateError):
                destination = self.root / ('source-' + str(len(payload)))
                updater.download_source(CONFIG, B, destination, lambda *_a, **_kw: io.BytesIO(payload))

    def test_limits_download_and_extracted_size(self):
        for constant in ['MAX_ARCHIVE_BYTES', 'MAX_SOURCE_BYTES']:
            with self.subTest(constant=constant), patch.object(updater, constant, 1):
                with self.assertRaises(updater.UpdateError):
                    destination = self.root / constant
                    payload = source_archive()
                    updater.download_source(CONFIG, B, destination, lambda *_a, **_kw: io.BytesIO(payload))

    def test_rejects_duplicate_files(self):
        with self.assertRaises(updater.UpdateError):
            self.download(source_archive(entries=[('duplicate', 'one'), ('duplicate', 'two')]))

    def test_limits_archive_entry_count(self):
        with patch.object(updater, 'MAX_SOURCE_FILES', 1), self.assertRaises(updater.UpdateError):
            self.download(source_archive(entries=[('one', '1'), ('two', '2')]))

    def test_source_receipt_does_not_use_git_or_user_override(self):
        root = self.root / 'src'
        root.mkdir()
        (self.root / updater.SOURCE_RECEIPT).write_text(json.dumps({'source': CONFIG, 'sha': B}))
        with patch.object(updater.subprocess, 'check_output', side_effect=AssertionError('must not invoke Git')):
            receipt = updater.source_receipt(root)
        self.assertEqual(receipt, {'source': CONFIG, 'sha': B})
        state_path = self.root / 'state.json'
        self.assertEqual(updater.check(CONFIG, {}, state_path, 'login',
                         lambda *_: {'sha': B}, installed=receipt)['status'], 'current')

    def test_rejects_invalid_source_receipt(self):
        root = self.root / 'src'
        root.mkdir()
        (self.root / updater.SOURCE_RECEIPT).write_text(json.dumps({'source': CONFIG, 'sha': 'invalid'}))
        with self.assertRaises(updater.UpdateError):
            updater.source_receipt(root)

    def test_local_git_receipt_remains_supported(self):
        root = self.root / 'src'
        (root / 'config').mkdir(parents=True)
        (root / 'config/update.json').write_text(json.dumps(CONFIG))
        (self.root / '.git').touch()
        with patch.dict(os.environ, {'XDG_CONFIG_HOME': str(self.root / 'config')}), \
                patch.object(updater.subprocess, 'check_output', return_value=B + '\n'):
            self.assertEqual(updater.source_receipt(root), {'source': CONFIG, 'sha': B})

    def test_selected_branch_becomes_the_bundled_update_source(self):
        config = {**CONFIG, 'branch': 'stable'}
        def run(args, cwd=None, **kwargs):
            with patch.dict(os.environ, {'XDG_CONFIG_HOME': str(self.root / 'absent-config')}):
                installed_source = updater.configuration(Path(cwd) / 'src')
            self.assertEqual(installed_source, config)
            self.assertEqual(updater.source_receipt(Path(cwd) / 'src'), {'source': config, 'sha': B})
        updater.install_source(config, B, run, fixture_source, parent=self.root)
        self.assertFalse(list(self.root.glob('source-*')))

    def test_interrupted_installer_is_stopped(self):
        with patch.object(updater.subprocess, 'Popen') as popen, patch.object(updater.os, 'killpg') as kill:
            process = popen.return_value
            process.pid = 42
            process.poll.return_value = None
            process.wait.side_effect = [KeyboardInterrupt, 0]
            with self.assertRaises(KeyboardInterrupt):
                updater.run_command(['bash', 'install.sh'])
            kill.assert_called_once_with(42, updater.signal.SIGKILL)

    def test_standalone_helper_bootstraps_without_installed_configuration(self):
        helper = self.root / 'updater.py'
        helper.write_text(Path(updater.__file__).read_text())
        payload = self.root / 'archive.tar.gz'
        payload.write_bytes(source_archive(entries=[('src/scripts/install.sh',
            'cp .pingoose-source.json ../../installed-receipt.json\n')]))
        wrapper = '''
import io, pathlib, runpy, sys
from unittest.mock import patch
helper, payload = sys.argv[1:3]
sys.argv = [helper] + sys.argv[3:]
with patch('urllib.request.urlopen', return_value=io.BytesIO(pathlib.Path(payload).read_bytes())):
    runpy.run_path(helper, run_name='__main__')
'''
        result = subprocess.run([sys.executable, '-c', wrapper, str(helper), str(payload),
            'bootstrap', '--repository', CONFIG['repository'], '--branch', 'main', '--commit', B],
            env=dict(os.environ, XDG_STATE_HOME=str(self.root / 'state'),
                     XDG_CONFIG_HOME=str(self.root / 'absent-config')), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'installed')
        updates = self.root / 'state/pingoose/updates'
        self.assertEqual(json.loads((updates / 'installed-receipt.json').read_text()),
                         {'source': CONFIG, 'sha': B})
        self.assertFalse(list(updates.glob('source-*')))

    def test_busy_bootstrap_exits_with_failure(self):
        updates = self.root / 'state/pingoose/updates'
        updates.mkdir(parents=True)
        with (updates / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run([sys.executable, updater.__file__, 'bootstrap',
                '--repository', CONFIG['repository'], '--commit', B],
                env=dict(os.environ, XDG_STATE_HOME=str(self.root / 'state')),
                text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['status'], 'error')


if __name__ == '__main__':
    unittest.main()
