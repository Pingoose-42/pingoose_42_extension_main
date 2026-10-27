#!/usr/bin/env python3
"""Pingoose의 최초 설치와 업데이트 확인, 승인한 커밋의 설치를 처리한다."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request


class UpdateError(Exception):
    pass


SOURCE_RECEIPT = '.pingoose-source.json'
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_SOURCE_BYTES = 128 * 1024 * 1024
MAX_SOURCE_ENTRIES = 10000


def load_json(path, default=None):
    try:
        with path.open() as stream:
            return json.load(stream)
    except FileNotFoundError:
        return default


def save_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.update-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def is_commit(sha):
    return isinstance(sha, str) and re.fullmatch('[0-9a-f]{40}', sha) is not None


def validate_commit(sha, message='설치할 커밋은 40자리 SHA로 지정해 주세요.'):
    if not is_commit(sha):
        raise UpdateError(message)
    return sha


def validate_configuration(config):
    if not isinstance(config, dict):
        raise UpdateError('업데이트에 사용할 저장소 설정을 찾을 수 없습니다.')
    repository = config.get('repository', '')
    if not isinstance(repository, str):
        raise UpdateError('업데이트 저장소는 GitHub의 HTTPS 주소로 지정해 주세요.')
    repository = repository.rstrip('/').removesuffix('.git')
    if not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise UpdateError('업데이트 저장소는 GitHub의 HTTPS 주소로 지정해 주세요.')
    branch = config.get('branch', 'main')
    if (not isinstance(branch, str)
            or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}', branch)
            or '..' in branch or branch.endswith('/')):
        raise UpdateError('업데이트할 브랜치, 태그 또는 커밋 SHA가 올바른지 확인해 주세요.')
    return {'repository': repository, 'branch': branch}


def configuration(root):
    override = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'pingoose/update.json'
    return validate_configuration(load_json(override, load_json(root / 'config/update.json')))


def source_receipt(root):
    """내려받은 소스에 남긴 기록이나 로컬 Git 커밋을 읽어 설치할 버전을 확인한다."""
    receipt = load_json(root.parent / SOURCE_RECEIPT)
    if receipt is not None:
        if not isinstance(receipt, dict):
            raise UpdateError('설치할 소스의 버전 기록을 읽을 수 없습니다.')
        return {'source': validate_configuration(receipt.get('source')),
                'sha': validate_commit(receipt.get('sha'), '소스의 버전 기록에 올바른 커밋 SHA가 없습니다.')}
    if (root.parent / '.git').exists():
        sha = subprocess.check_output(['git', '-C', str(root.parent), 'rev-parse', 'HEAD'], text=True).strip()
        return {'source': configuration(root), 'sha': validate_commit(sha)}
    return None


def extract_source(archive_path, destination, expected_root):
    """압축 파일의 경로와 항목을 확인한 뒤 소스 디렉터리에 푼다."""
    with tarfile.open(archive_path, 'r:gz') as archive:
        total_bytes = 0
        for index, member in enumerate(archive):
            if index >= MAX_SOURCE_ENTRIES:
                raise UpdateError('압축 파일에 포함된 항목이 허용 개수를 넘었습니다.')
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != expected_root:
                raise UpdateError('요청한 커밋의 소스 압축 파일인지 확인할 수 없습니다.')
            if '..' in parts or '\\' in member.name:
                raise UpdateError('압축 파일에 소스 디렉터리를 벗어나는 경로가 있습니다.')
            if not (member.isdir() or member.isfile()):
                raise UpdateError('소스 압축 파일에는 일반 파일과 디렉터리만 넣을 수 있습니다.')

            target = destination.joinpath(*parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if len(parts) < 2:
                raise UpdateError('압축 파일의 최상위 항목은 디렉터리여야 합니다.')
            total_bytes += member.size
            if total_bytes > MAX_SOURCE_BYTES:
                raise UpdateError('압축을 푼 소스의 크기가 허용 한도를 넘었습니다.')
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o644 | (member.mode & 0o111))
    if not (destination / 'src/scripts/install.sh').is_file():
        raise UpdateError('내려받은 소스에서 src/scripts/install.sh를 찾을 수 없습니다.')


def download_source(config, sha, destination, open_url=urllib.request.urlopen):
    """GitHub에서 지정한 커밋의 소스를 받아 새 디렉터리에 푼다."""
    config = validate_configuration(config)
    sha = validate_commit(sha)
    repository = config['repository'].removeprefix('https://github.com/')
    archive_url = f'https://codeload.github.com/{repository}/tar.gz/{sha}'
    expected_root = repository.split('/')[-1] + '-' + sha
    destination.mkdir()
    archive_path = destination.parent / 'source.tar.gz'
    request = urllib.request.Request(archive_url, headers={'User-Agent': 'Pingoose-Updater'})
    try:
        with open_url(request, timeout=60) as response, archive_path.open('wb') as output:
            downloaded = 0
            while chunk := response.read(1024 * 1024):
                downloaded += len(chunk)
                if downloaded > MAX_ARCHIVE_BYTES:
                    raise UpdateError('내려받을 소스 압축 파일이 허용 크기를 넘었습니다.')
                output.write(chunk)
        extract_source(archive_path, destination, expected_root)
    except (OSError, ValueError, tarfile.TarError) as error:
        raise UpdateError(f'소스를 내려받거나 압축을 풀지 못했습니다: {error}') from error


def install_source(config, sha, run, fetch=download_source, parent=None):
    """임시 소스에 설치 출처를 기록한 뒤 설치 스크립트를 실행한다."""
    config = validate_configuration(config)
    sha = validate_commit(sha)
    with tempfile.TemporaryDirectory(prefix='source-', dir=parent) as temporary:
        source = Path(temporary) / 'source'
        fetch(config, sha, source)
        # 다음 업데이트에서도 사용자가 선택한 저장소와 참조를 확인하도록 저장한다.
        (source / 'src/config').mkdir(parents=True, exist_ok=True)
        save_json(source / 'src/config/update.json', config)
        save_json(source / SOURCE_RECEIPT, {'source': config, 'sha': sha})
        run(['bash', './src/scripts/install.sh'], cwd=str(source), timeout=300)


def session_key():
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    session = os.environ.get('XDG_SESSION_ID')
    if not session:
        # Shell을 재시작해도 같은 로그인 세션에서 자동 확인을 반복하지 않는다.
        try:
            from gi.repository import Gio, GLib
            bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
            session = bus.call_sync('org.freedesktop.login1', '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager', 'GetSessionByPID',
                GLib.Variant('(u)', (os.getpid(),)), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
        except Exception:
            try:
                # 사용자 서비스에서는 프로세스 대신 사용자 관리자의 시작 시각으로 세션을 구분한다.
                user = bus.call_sync('org.freedesktop.login1', '/org/freedesktop/login1',
                    'org.freedesktop.login1.Manager', 'GetUser',
                    GLib.Variant('(u)', (os.getuid(),)), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
                started = bus.call_sync('org.freedesktop.login1', user,
                    'org.freedesktop.DBus.Properties', 'Get',
                    GLib.Variant('(ss)', ('org.freedesktop.login1.User', 'TimestampMonotonic')),
                    None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
                session = f'user:{started}'
            except Exception as error:
                raise UpdateError('현재 GNOME 로그인 세션을 확인하지 못했습니다.') from error
    return hashlib.sha256(f'{boot}:{session}'.encode()).hexdigest()


def github(config, route):
    repo = config['repository'].removeprefix('https://github.com/')
    request = urllib.request.Request(f'https://api.github.com/repos/{repo}/{route}', headers={
        'Accept': 'application/vnd.github+json', 'User-Agent': 'Pingoose-Updater',
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read(1048577)
        if len(data) > 1048576:
            raise UpdateError('GitHub 응답이 허용 크기를 넘었습니다.')
        return json.loads(data)
    except urllib.error.HTTPError as error:
        raise UpdateError(f'GitHub에서 업데이트 정보를 받지 못했습니다. HTTP 상태 코드: {error.code}') from error
    except (OSError, ValueError) as error:
        raise UpdateError('GitHub에 연결하거나 응답을 읽지 못했습니다. 잠시 후 업데이트를 다시 확인해 주세요.') from error


def check(config, state, path, login, api=github, force=False, installed=None):
    if not force and state.get('session') == login:
        return {'status': 'skipped'}
    state['session'] = login
    # 요청 전에 세션을 기록해, 확장을 다시 켜도 같은 자동 확인을 반복하지 않는다.
    save_json(path, state)
    latest = api(config, 'commits/' + urllib.parse.quote(config['branch'], safe=''))
    sha = validate_commit(latest.get('sha') if isinstance(latest, dict) else None,
                          'GitHub 응답에서 올바른 커밋 SHA를 찾지 못했습니다.')
    commit = {'sha': sha, 'date': latest.get('commit', {}).get('committer', {}).get('date', ''),
              'message': latest.get('commit', {}).get('message', '').split('\n')[0][:180]}
    # 수동 설치로 버전이 바뀔 수 있으므로 설치 파일에 남긴 커밋을 먼저 읽는다.
    if isinstance(installed, dict) and installed.get('source') == config and is_commit(installed.get('sha')):
        installed_sha = installed['sha']
    elif state.get('source') == config and state.get('installed'):
        installed_sha = state['installed']['sha']
    else:
        installed_sha = None
    if state.get('source') != config:
        state.pop('installed', None)
    state['source'] = dict(config)
    state['candidate'] = None
    changes = [commit]
    if installed_sha is None:
        state['candidate'] = commit
    elif sha != installed_sha:
        comparison = api(config, f'compare/{installed_sha}...{sha}')
        if comparison.get('status') in ('ahead', 'diverged'):
            state['candidate'] = commit
            commits = comparison.get('commits', [])
            if comparison.get('total_commits', len(commits)) > len(commits):
                commits = []
                page = 1
                while True:
                    batch = api(config, f'compare/{installed_sha}...{sha}?per_page=100&page={page}').get('commits', [])
                    commits.extend(batch)
                    if len(batch) < 100:
                        break
                    page += 1
            changes = [{'sha': item.get('sha', ''),
                        'message': item.get('commit', {}).get('message', '').split('\n')[0][:500]}
                       for item in commits] or [commit]
    if state['candidate']:
        state['candidate'] = {**commit, 'changes': changes}
    save_json(path, state)
    if state['candidate']:
        return {'status': 'available', 'commit': commit, **config}
    return {'status': 'current'}


def run_command(args, cwd=None, timeout=180, quiet=True):
    process = subprocess.Popen(args, cwd=cwd, stdout=subprocess.DEVNULL if quiet else None,
                               stderr=subprocess.DEVNULL if quiet else None, start_new_session=True)
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise UpdateError('설치 시간이 제한을 넘어 작업을 중단했습니다. 잠시 후 다시 시도해 주세요.') from error
    except KeyboardInterrupt:
        # 사용자가 취소하면 설치 프로세스를 먼저 멈춘 뒤 임시 소스를 정리한다.
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        raise
    if process.returncode:
        raise UpdateError(f'설치 명령({args[0]})이 종료 코드 {process.returncode}로 실패했습니다.')


def install(config, state, path, approved, run=run_command, fetch=download_source):
    candidate = state.get('candidate')
    if state.get('source') != config or not candidate or candidate.get('sha') != approved:
        raise UpdateError('승인한 업데이트와 현재 저장소 설정이 일치하지 않습니다. 업데이트를 다시 확인해 주세요.')
    approved = validate_commit(approved)
    # 승인한 SHA로 다운로드하므로, 확인 뒤 브랜치가 바뀌어도 같은 커밋을 설치한다.
    install_source(config, approved, run, fetch, parent=path.parent)
    state.update(baseline=candidate, installed=candidate, candidate=None)
    save_json(path, state)
    return {'status': 'installed', 'commit': candidate}


def parse_args():
    parser = argparse.ArgumentParser(description='Pingoose의 설치와 업데이트를 실행합니다.')
    parser.add_argument('action', choices=['check', 'install', 'bootstrap'])
    parser.add_argument('--commit', help='설치할 커밋의 전체 SHA')
    parser.add_argument('--force', action='store_true', help='같은 로그인 세션에서도 업데이트를 다시 확인')
    parser.add_argument('--repository', help='최초 설치에 사용할 GitHub 저장소의 HTTPS 주소')
    parser.add_argument('--branch', default='main', help='설치 후 업데이트를 확인할 브랜치, 태그 또는 커밋')
    return parser.parse_args()


def main(args):
    root = Path(__file__).resolve().parent.parent
    directory = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'pingoose/updates'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / 'state.json'
    # 최초 설치와 업데이트가 같은 파일을 동시에 바꾸지 않도록 잠근다.
    with (directory / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if args.action == 'bootstrap':
                raise UpdateError('다른 설치나 업데이트가 진행 중입니다. 끝난 뒤 다시 실행해 주세요.')
            return {'status': 'busy'}
        if args.action == 'bootstrap':
            config = validate_configuration({'repository': args.repository or '', 'branch': args.branch})
            install_source(config, args.commit,
                           lambda *a, **kw: run_command(*a, **kw, quiet=False), parent=directory)
            return {'status': 'installed', 'commit': {'sha': args.commit}}
        config = configuration(root)
        state = load_json(path, {})
        if args.action == 'check':
            return check(config, state, path, session_key(), force=args.force,
                         installed=load_json(root / 'config/installed.json'))
        return install(config, state, path, args.commit)


def cli():
    args = parse_args()
    try:
        result = main(args)
    except Exception as error:
        if args.action == 'bootstrap':
            print(f'설치를 마치지 못했습니다: {error}', file=sys.stderr)
        else:
            print(json.dumps({'status': 'error', 'error': str(error)[:300]}, ensure_ascii=False))
        return 1
    # GNOME과 통신하는 check/install은 JSON을 반환한다. 터미널에서는 설치 스크립트의 안내를 보여 준다.
    if args.action != 'bootstrap':
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(cli())
