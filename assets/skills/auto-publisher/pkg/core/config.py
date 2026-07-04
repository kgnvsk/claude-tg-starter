"""Hot-reload config watcher.

Engine reads configs through this layer. Files in configs/ can be edited live
(by the admin bot or manually) — get() re-reads when mtime changes. No restart
needed.
"""
import json
import os
from pathlib import Path
from threading import Lock


class ConfigWatcher:
    def __init__(self, path: Path, parser=None):
        self.path = Path(path)
        self.mtime = 0.0
        self.value = None
        self.parser = parser or (lambda p: json.loads(p.read_text()))
        self.lock = Lock()

    def get(self):
        try:
            current_mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            return self.value
        if current_mtime > self.mtime:
            with self.lock:
                if current_mtime > self.mtime:
                    try:
                        self.value = self.parser(self.path)
                        self.mtime = current_mtime
                    except Exception as e:
                        print(f"⚠️ ConfigWatcher: failed to reload {self.path}: {e}")
        return self.value


class Configs:
    """Bundle of all live configs. Pass --config-dir at startup; engine asks
    for sources / filters / style / admin / examples via this object.
    """
    def __init__(self, config_dir: Path):
        self.config_dir = Path(config_dir)
        self.sources = ConfigWatcher(self.config_dir / 'sources.json')
        self.filters = ConfigWatcher(self.config_dir / 'filters.json')
        self.admin = ConfigWatcher(self.config_dir / 'admin.json')
        self.style = ConfigWatcher(
            self.config_dir / 'style.md',
            parser=lambda p: p.read_text(),
        )

    def examples(self) -> list[str]:
        """Read all .md files in configs/examples/ — each is one ideal post.
        Engine picks 3-5 at random as few-shot in the rewrite prompt.
        """
        ex_dir = self.config_dir / 'examples'
        if not ex_dir.exists():
            return []
        out = []
        for p in sorted(ex_dir.glob('*.md')):
            try:
                out.append(p.read_text())
            except Exception:
                pass
        return out
