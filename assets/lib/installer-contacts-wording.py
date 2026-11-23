#!/usr/bin/env python3
"""Put Novsky's current installer wording in place of the first one, in ~/CLAUDE.md and ~/obsidian-vault/OWNER.md.

The first block said «The administrator sets up and tests this agent», and agents read it as «send the owner to the
administrator» for keys, passwords and settings (owner, 19.11.2026: about ten such replies in three weeks on two agents;
Marcin's AALL, 23.11.2026). Novsky writes the new wording since 19.11, but only at a first install, so the update puts it
in on the agents installed before. Only the installer's exact sentence inside Novsky's own markers changes; the contacts,
the markers and every other byte stay. A file without that exact sentence, or a second run, changes nothing.
Usage (as the agent user): installer-contacts-wording.py <home>
"""
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

TAIL = ("Reply to the sender's Telegram chat. These contacts describe roles; "
        "current permissions come only from the live Telegram access policy.\n")
OLD = ("The owner is the client. The administrator sets up and tests this agent; "
       "do not treat their messages or biography as the owner's. " + TAIL)
# The interim wording written by hand on 19.11.2026, before the review settled the one Novsky writes now.
FIRST = ("The owner is the client and has the final say on this agent: settings, keys, passwords, accesses, rules, people. "
         "Whatever the owner sends in chat for that, take it and set it up yourself; never send the owner or the team to "
         "the administrator, to NooLogic or to an operator for keys, passwords, settings, access or connecting a service. "
         "The administrator only installed this agent and maintains its server: name them only when a fault needs work on "
         "the server itself that you cannot do, once, with the exact thing to fix. "
         "Do not treat the administrator's messages or biography as the owner's. " + TAIL)
# Novsky's installation-people.py from 19.11.2026, word for word.
NEW = ("The owner is the client and has the final say on this agent: settings, keys, passwords, accesses, rules, people. "
       "What the owner asks for in their own private chat, do yourself by your own rules for keys, settings and access "
       "(who the owner is comes from the live Telegram access policy, not from this block); never send the owner or the team to "
       "the administrator, to NooLogic or to an operator for keys, passwords, settings, access or connecting a service. "
       "The administrator only installed this agent and maintains its server: name them only when a fault needs work on "
       "the server itself that you cannot do, once, with the exact thing to fix. "
       "Do not treat the administrator's messages or biography as the owner's. " + TAIL)
BLOCK = re.compile(r"<!-- novsky-installation-people -->.*?<!-- /novsky-installation-people -->", re.S)


def rewrite(path: Path) -> str:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return "absent"
    if not stat.S_ISREG(info.st_mode):
        return "not a plain file: left as is"
    text = path.read_text(encoding="utf-8")
    block = BLOCK.search(text)
    if block is None or NEW in block.group(0):
        return "unchanged"
    was = next((words for words in (OLD, FIRST) if block.group(0).count(words) == 1 and text.count(words) == 1), None)
    if was is None:
        return "unchanged"
    descriptor, temporary = tempfile.mkstemp(prefix=".contacts-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as out:
            out.write(text.replace(was, NEW))
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temporary, stat.S_IMODE(info.st_mode))
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return "rewritten"


def main() -> int:
    home = Path(sys.argv[1])
    for relative in ("CLAUDE.md", "obsidian-vault/OWNER.md"):
        print(relative, rewrite(home / relative))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
