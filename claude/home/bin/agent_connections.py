#!/usr/bin/env python3
"""Internal readers for agent-connections; no credential-printing command line."""
import importlib.machinery
import importlib.util
from pathlib import Path

_loader = importlib.machinery.SourceFileLoader('novsky_connection_store', str(Path(__file__).with_name('agent-connections')))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
_store = importlib.util.module_from_spec(_spec)
_loader.exec_module(_store)
load_value = _store.load_value
configure_local = _store.configure_local
ConnectionError = _store.ConnectionError


def provider_environment(home, provider, environment):
    """Only fixed provider credentials are exported, never custom runtime names."""
    if provider not in _store.PROVIDERS:
        raise ConnectionError('invalid_provider')
    with _store.Store(str(home)) as store:
        store.migrate()
        name = _store.PROVIDERS[provider][0]
        key = _store.identity(provider, name)
        output = dict(environment)
        if key in store.values:
            value = store.values[key]
            for setting in ((name, 'GH_TOKEN') if provider == 'github' else (name,)):
                output.pop(setting, None)
                if value: output[setting] = value
        elif provider == 'vercel':
            value = store.legacy_provider_value(provider)
            if value: output[name] = value
        return output
