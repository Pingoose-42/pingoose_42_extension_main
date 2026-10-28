"""Run the public installer with temporary download and installation fixtures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[2] / 'install.sh'
SHA = 'b' * 40


@unittest.skipIf(os.geteuid() == 0, 'The installer requires a desktop user.')
class Installer(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.temporary = self.root / 'temporary'
        self.temporary.mkdir()
        for command in ['mktemp', 'rm', 'dirname', 'bash']:
            (self.bin / command).symlink_to(shutil.which(command))
        (self.bin / 'python3').symlink_to(sys.executable)
        self.env = dict(os.environ, PATH=str(self.bin), TMPDIR=str(self.temporary),
                        FIXTURE_ROOT=str(self.root), FIXTURE_SHA=SHA)
        self.env.pop('SUDO_USER', None)
        curl = self.bin / 'curl'
        curl.write_text(f'#!{sys.executable}\n' + '''
import json, os
from pathlib import Path
import sys
root = Path(os.environ['FIXTURE_ROOT'])
url = sys.argv[-1]
with (root / 'requests').open('a') as stream:
    stream.write(url + '\\n')
if os.environ.get('FIXTURE_DOWNLOAD_FAILURE'):
    sys.exit(22)
output = Path(sys.argv[sys.argv.index('--output') + 1])
if url.endswith('/commits/main'):
    output.write_text(json.dumps({'sha': os.environ['FIXTURE_SHA']}))
elif url.endswith('/src/worker/updater.py'):
    output.write_text((root / 'helper.py').read_text())
else:
    sys.exit('Unexpected request: ' + url)
''')
        curl.chmod(0o755)
        (self.root / 'helper.py').write_text('''
import json, os
from pathlib import Path
import sys
root = Path(os.environ['FIXTURE_ROOT'])
(root / 'result').write_text(json.dumps(sys.argv[1:]))
sys.exit(int(os.environ.get('FIXTURE_INSTALL_FAILURE', '0')))
''')

    def invoke(self, *args, script=None):
        command = [shutil.which('bash')]
        if script:
            command.extend([str(script), *args])
            content = None
        else:
            command.extend(['-s', '--', *args])
            content = INSTALLER.read_text()
        return subprocess.run(command, input=content, cwd=self.root, env=self.env,
                              text=True, capture_output=True)

    def test_stdin_downloads_helper_at_selected_commit(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.root / 'result').read_text()),
            ['bootstrap', '--repository', 'https://github.com/Pingoose-42/pingoose_42_extension_main',
             '--commit', SHA])
        self.assertIn('/' + SHA + '/src/worker/updater.py', (self.root / 'requests').read_text())
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_downloaded_script_runs_without_checkout(self):
        script = self.root / 'install.sh'
        script.write_text(INSTALLER.read_text())
        result = self.invoke(script=script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / 'result').exists())

    def test_local_install_uses_adjacent_sources(self):
        checkout = self.root / 'checkout'
        scripts = checkout / 'src/scripts'
        scripts.mkdir(parents=True)
        script = checkout / 'install.sh'
        script.write_text(INSTALLER.read_text())
        (scripts / 'install.sh').write_text('printf local > "$FIXTURE_ROOT/result"\n')
        (self.bin / 'curl').unlink()
        (self.bin / 'python3').unlink()
        result = self.invoke(script=script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'result').read_text(), 'local')

    def test_stdin_does_not_run_installer_in_current_directory(self):
        scripts = self.root / 'src/scripts'
        scripts.mkdir(parents=True)
        (scripts / 'install.sh').write_text('exit 99\n')
        self.assertEqual(self.invoke().returncode, 0)
        self.assertTrue((self.root / 'result').exists())

    def test_download_failure_stops_and_cleans_temporary_files(self):
        self.env['FIXTURE_DOWNLOAD_FAILURE'] = '1'
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse((self.root / 'result').exists())
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_invalid_commit_stops_before_helper_download(self):
        self.env['FIXTURE_SHA'] = 'invalid'
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual(len((self.root / 'requests').read_text().splitlines()), 1)
        self.assertFalse((self.root / 'result').exists())
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_install_failure_propagates_and_cleans_temporary_files(self):
        self.env['FIXTURE_INSTALL_FAILURE'] = '3'
        self.assertEqual(self.invoke().returncode, 3)
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_help_exits_without_downloading(self):
        self.assertEqual(self.invoke('--help').returncode, 0)
        self.assertFalse((self.root / 'requests').exists())


if __name__ == '__main__':
    unittest.main()
