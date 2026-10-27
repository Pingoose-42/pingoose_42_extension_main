"""설치 파일을 임시 폴더로 대체해 셸 설치기의 실행 흐름을 확인한다."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / 'install.sh'
SHA = 'b' * 40


@unittest.skipIf(os.geteuid() == 0, '설치기는 일반 사용자 계정으로 실행해야 한다.')
class Installer(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.tmp = self.root / 'tmp'
        self.tmp.mkdir()
        self.calls = self.root / 'downloads.jsonl'
        self.result = self.root / 'installed.json'
        self.env = dict(os.environ, PATH=str(self.bin), TMPDIR=str(self.tmp),
                        FIXTURE_CALLS=str(self.calls), FIXTURE_RESULT=str(self.result))
        self.env.pop('SUDO_USER', None)
        for command in ['python3', 'mktemp', 'rm', 'dirname']:
            (self.bin / command).symlink_to(shutil.which(command))
        curl = self.bin / 'curl'
        curl.write_text(f'#!{sys.executable}\n' + '''
import json, os, pathlib, sys
args = sys.argv[1:]
url = next(arg for arg in args if arg.startswith('https://'))
output = pathlib.Path(args[args.index('--output') + 1])
with open(os.environ['FIXTURE_CALLS'], 'a') as stream:
    stream.write(json.dumps(args) + '\\n')
if os.environ.get('FIXTURE_CURL_FAIL'):
    sys.exit(22)
if 'api.github.com' in url:
    output.write_text(json.dumps({'sha': os.environ.get('FIXTURE_SHA', 'b' * 40)}))
else:
    output.write_text("import json, os, pathlib, sys\\n"
                      "pathlib.Path(os.environ['FIXTURE_RESULT']).write_text(json.dumps(sys.argv[1:]))\\n"
                      "sys.exit(int(os.environ.get('FIXTURE_HELPER_EXIT', '0')))\\n")
''')
        curl.chmod(0o755)

    def run_installer(self, *args, stdin=True):
        command = [shutil.which('bash')]
        command += ['-s', '--'] if stdin else [str(INSTALLER)]
        return subprocess.run(command + list(args), input=INSTALLER.read_text() if stdin else None,
                              cwd=self.root, env=self.env, text=True, capture_output=True)

    def test_piped_install_pins_helper_and_needs_no_git(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.result.read_text())
        self.assertEqual(args, ['bootstrap', '--repository',
            'https://github.com/Pingoose-42/pingoose_42_extension_main', '--branch', 'main', '--commit', SHA])
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertIn(f'https://raw.githubusercontent.com/Pingoose-42/pingoose_42_extension_main/{SHA}/src/worker/updater.py', calls[1])
        self.assertIn('--proto-redir', calls[0])
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_branch_with_slash_is_encoded(self):
        result = self.run_installer('--ref', 'feature/example')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('/commits/feature%2Fexample', self.calls.read_text())

    def test_download_failure_does_not_execute_helper(self):
        self.env['FIXTURE_CURL_FAIL'] = '1'
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.result.exists())
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_invalid_commit_does_not_execute_helper(self):
        self.env['FIXTURE_SHA'] = 'not-a-commit'
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.result.exists())
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_install_failure_is_reported_and_temporary_files_removed(self):
        self.env['FIXTURE_HELPER_EXIT'] = '1'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_help_and_invalid_arguments_do_not_download(self):
        self.assertEqual(self.run_installer('--help').returncode, 0)
        for args in [('--ref',), ('--ref', '../bad'), ('--unexpected',)]:
            self.assertNotEqual(self.run_installer(*args).returncode, 0)
        self.assertFalse(self.calls.exists())

    def test_local_checkout_installs_without_network(self):
        checkout = self.root / 'checkout'
        scripts = checkout / 'src/scripts'
        scripts.mkdir(parents=True)
        (checkout / 'install.sh').write_text(INSTALLER.read_text())
        (scripts / 'install.sh').write_text('printf local > "$FIXTURE_RESULT"\n')
        # 로컬 소스가 있으면 내려받기 없이 설치 스크립트를 바로 실행한다.
        (self.bin / 'bash').symlink_to(shutil.which('bash'))
        result = subprocess.run([shutil.which('bash'), str(checkout / 'install.sh')],
                                cwd=self.root, env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.result.read_text(), 'local')
        self.assertFalse(self.calls.exists())


if __name__ == '__main__':
    unittest.main()
