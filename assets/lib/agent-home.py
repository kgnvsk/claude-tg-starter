#!/usr/bin/env python3
"""Directories, copies and files that root makes or adopts inside an agent's home, without following a link the agent
could have planted.

The agent owns its home, so by the time an installer runs as root any directory there may be a symlink: `install -d -o`
then hands the link's target to the agent (a system directory would become the agent's), and a copy or a chown lands
wherever the link points (Codex, 20.11.2026). Here every component below the home is opened from its parent's descriptor
with O_NOFOLLOW, so nothing is followed and nothing can be swapped in between. A directory or a copy through a link the
agent made (a cache moved to another disk, say) is done with the agent's own rights instead: the link then leads only
where the agent could write anyway, and a step the agent may not take refuses (exit 3). A file root wrote and hands to
the agent is adopted, and a file of the agent's that root reads is read, only through plain directories and as the
regular file itself. Only root sets the owner: any other caller (the tests) already owns what it makes.

Usage:
  agent-home.py <home> <user> dir <mode> <directory>...    each directory and its missing parents (0755), the agent's;
                                                             the named ones get the mode
  agent-home.py <home> <user> copy <mode> <source> <file>  the trusted source copied over the file, the agent's, the mode
  agent-home.py <home> <user> own <mode|-> <file>...       each regular file made the agent's, with the mode (- keeps it)
  agent-home.py <home> <user> read <file>                  the file to stdout; exit 4 when it or a folder on its way is
                                                             missing
"""
from __future__ import annotations

import errno
import os
import pwd
import secrets
import stat
import subprocess
import sys

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class Refused(Exception):
    pass


def below(home: str, path: str) -> list[str]:
    inside, top = os.path.normpath(path), os.path.normpath(home)
    if not inside.startswith(top.rstrip("/") + "/"):
        raise Refused(f"{path} поза домом {home}")
    return inside[len(top.rstrip("/")) + 1:].split("/")


def walk(home: int, names: list[str], owner: tuple[int, int] | None, create: bool) -> int:
    """The descriptor of the directory names lead to below the home, each step opened without following a link."""
    fd = os.dup(home)
    for name in names:
        try:
            try:
                step = os.open(name, DIRECTORY, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                    made = True
                except FileExistsError:  # made meanwhile: opened below, without following it either
                    made = False
                step = os.open(name, DIRECTORY, dir_fd=fd)
                if made:
                    # Still the empty directory made just now, not one moved into its name meanwhile.
                    if os.fstat(step).st_uid != os.geteuid() or os.listdir(step):
                        os.close(step)
                        raise Refused(f"{'/'.join(names)}: «{name}» підмінено під час створення")
                    if owner:
                        os.fchown(step, *owner)
                    os.fchmod(step, 0o755)
        except OSError as error:
            os.close(fd)
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                raise Refused(f"{'/'.join(names)}: «{name}» — посилання або не тека") from None
            raise
        os.close(fd)
        fd = step
    return fd


def as_agent(user: str, command: list[str], refusal: Refused) -> None:
    """One step through a link the agent made, with the agent's own rights."""
    if subprocess.run(["runuser", "-u", user, "--", *command] if os.geteuid() == 0 else command).returncode != 0:
        raise refusal


def make_dirs(home: int, top: str, user: str, owner: tuple[int, int] | None, mode: int, paths: list[str]) -> None:
    for path in paths:
        names = below(top, path)
        try:
            fd = walk(home, names, owner, create=True)
        except Refused as refusal:
            as_agent(user, ["install", "-d", "-m", f"{mode:o}", path], refusal)
            continue
        try:
            if owner:
                os.fchown(fd, *owner)
            os.fchmod(fd, mode)
        finally:
            os.close(fd)


def copy(home: int, top: str, user: str, owner: tuple[int, int] | None, mode: int, source: str, path: str) -> None:
    *parents, name = below(top, path)
    with open(source, "rb") as handle:
        payload = handle.read()
    try:
        parent = walk(home, parents, owner, create=False)
    except Refused as refusal:
        # -T: a directory in the file's place fails instead of receiving the copy.
        as_agent(user, ["install", "-T", "-m", f"{mode:o}", source, path], refusal)
        return
    temporary = f".{name}.{secrets.token_hex(8)}"
    try:
        out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        try:
            view = memoryview(payload)
            while view:
                view = view[os.write(out, view):]
            if owner:
                os.fchown(out, *owner)
            os.fchmod(out, mode)
            os.fsync(out)
        finally:
            os.close(out)
        # A link at the file itself is replaced, never written through.
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=parent)
        except OSError:
            pass
        raise
    finally:
        os.close(parent)


def open_file(home: int, top: str, path: str) -> int:
    """The agent's regular file itself, reached through plain directories; a link, another kind of file or a file with
    other names refuses (another name could stand outside the home)."""
    *parents, name = below(top, path)
    parent = walk(home, parents, None, create=False)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC, dir_fd=parent)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise Refused(f"{path} — посилання") from None
        raise
    finally:
        os.close(parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        raise Refused(f"{path} — не звичайний файл або має інші імена (жорсткі посилання)")
    return fd


def read(home: int, top: str, path: str) -> None:
    fd = open_file(home, top, path)
    with os.fdopen(fd, "rb") as handle:
        sys.stdout.buffer.write(handle.read())
    sys.stdout.buffer.flush()


def own(home: int, top: str, owner: tuple[int, int] | None, mode: int | None, paths: list[str]) -> None:
    for path in paths:
        fd = open_file(home, top, path)
        try:
            if owner:
                os.fchown(fd, *owner)
            if mode is not None:
                os.fchmod(fd, mode)
        finally:
            os.close(fd)


def main(argv: list[str]) -> int:
    action = argv[3] if len(argv) > 3 else ""
    if not ((action in ("dir", "own") and len(argv) >= 6) or (action == "copy" and len(argv) == 7)
            or (action == "read" and len(argv) == 5)):
        print(__doc__[__doc__.index("Usage:"):].rstrip(), file=sys.stderr)
        return 2
    top, user = argv[1], argv[2]
    # own - keeps the file's mode; every other mode is octal.
    mode = None if action == "read" or (action == "own" and argv[4] == "-") else int(argv[4], 8)
    # Reading needs no account: an installer reads before it makes one.
    if os.geteuid() == 0 and action != "read":
        account = pwd.getpwnam(user)
        owner = (account.pw_uid, account.pw_gid)
    else:
        owner = None
    try:
        try:
            home = os.open(top, DIRECTORY)
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                raise Refused(f"дім {top} — посилання або не тека") from None
            raise
        try:
            if action == "read":
                read(home, top, argv[4])
            elif action == "dir":
                make_dirs(home, top, user, owner, mode, argv[5:])
            elif action == "copy":
                copy(home, top, user, owner, mode, argv[5], argv[6])
            else:
                own(home, top, owner, mode, argv[5:])
        finally:
            os.close(home)
    except Refused as error:
        print(f"agent-home: відмовлено, root не йде за посиланнями в домі агента: {error}", file=sys.stderr)
        return 3
    except FileNotFoundError as error:
        if action == "read":
            return 4
        print(f"agent-home: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"agent-home: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
