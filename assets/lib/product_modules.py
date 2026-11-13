#!/usr/bin/env python3
"""Модулі продукту: база, куплені модулі й ліцензія агента.

    product_modules.py validate --catalog C --modules LIST [--contact TEXT]
    product_modules.py render   --catalog C --modules LIST --contact TEXT --out PATH
    product_modules.py policy   --catalog C --modules LIST --policy KIT_POLICY --out PATH
    product_modules.py runtime  --catalog C --modules LIST --runtime KIT_RUNTIME --out PATH

Продавець відмічає модулі в Novsky; той пише їх у збережене середовище агента
(NOVSKY_MODULES, NOVSKY_MODULES_CONTACT). install-core перевіряє список,
складає з нього файл ліцензії /etc/claude-premium/modules/<користувач>.json
(root, 0644: агент читає, змінити не може) і політику навичок без того, що не
куплено. Агент без NOVSKY_MODULES — давній: ліцензії немає, усе як раніше.

Файл ліцензії самодостатній: хуки й помічники агента читають лише його, без
каталогу комплекту.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

MODULE_ID = re.compile(r"^[a-z][a-z0-9-]{1,30}$")
SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CHECK_NAME = re.compile(r"^[a-z][a-z0-9_]{1,40}$")
GOOGLE_SERVICE = re.compile(r"^[a-z]{2,20}$")
CONTACT_LIMIT = 200
LICENCE_DIR = Path("/etc/claude-premium/modules")
CONTACT_FALLBACK = "людина, яка встановила агента"


class ModuleError(ValueError):
    pass


def _strings(value, pattern, field):
    if not isinstance(value, list) or any(not isinstance(item, str) or not pattern.fullmatch(item) for item in value):
        raise ModuleError(f"каталог модулів: {field} має бути списком коректних назв")
    if len(value) != len(set(value)):
        raise ModuleError(f"каталог модулів: {field} містить повтори")
    return value


def load_catalog(path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise ModuleError(f"каталог модулів не читається: {error}") from error
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ModuleError("каталог модулів: schemaVersion має бути 1")
    base = data.get("base")
    if not isinstance(base, dict) or not isinstance(base.get("name"), str):
        raise ModuleError("каталог модулів: немає бази")
    if not isinstance(base.get("includes"), list) or any(not isinstance(item, str) or not item for item in base["includes"]):
        raise ModuleError("каталог модулів: base.includes має бути списком рядків")
    _strings(base.get("skills"), SKILL_NAME, "base.skills")
    _strings(base.get("checks"), CHECK_NAME, "base.checks")
    modules = data.get("modules")
    if not isinstance(modules, list) or not modules:
        raise ModuleError("каталог модулів: список modules порожній")
    seen = set()
    for module in modules:
        if not isinstance(module, dict):
            raise ModuleError("каталог модулів: модуль має бути обʼєктом")
        module_id = module.get("id")
        if not isinstance(module_id, str) or not MODULE_ID.fullmatch(module_id) or module_id in seen:
            raise ModuleError(f"каталог модулів: некоректний або повторний id {module_id!r}")
        seen.add(module_id)
        for field in ("name", "pitch"):
            if not isinstance(module.get(field), str) or not module[field].strip():
                raise ModuleError(f"каталог модулів: {module_id}.{field} порожній")
        _strings(module.get("skills"), SKILL_NAME, f"{module_id}.skills")
        _strings(module.get("kitModules"), MODULE_ID, f"{module_id}.kitModules")
        _strings(module.get("checks"), CHECK_NAME, f"{module_id}.checks")
        _strings(module.get("googleServices", []), GOOGLE_SERVICE, f"{module_id}.googleServices")
    return data


def module_ids(catalog: dict) -> list[str]:
    return [module["id"] for module in catalog["modules"]]


def parse_modules(text: str, catalog: dict) -> list[str]:
    """Кома-розділений список куплених модулів; порожній рядок — лише база."""
    if not isinstance(text, str):
        raise ModuleError("список модулів має бути рядком")
    names = [part.strip() for part in text.split(",")] if text.strip() else []
    if any(not name for name in names):
        raise ModuleError("список модулів містить порожній елемент")
    if len(names) != len(set(names)):
        raise ModuleError("список модулів містить повтори")
    known = set(module_ids(catalog))
    unknown = [name for name in names if name not in known]
    if unknown:
        raise ModuleError(f"невідомий модуль: {unknown[0]} (наявні: {', '.join(module_ids(catalog))})")
    order = module_ids(catalog)
    return sorted(names, key=order.index)


def check_contact(text: str) -> str:
    if not isinstance(text, str):
        raise ModuleError("контакт має бути рядком")
    value = text.strip()
    if len(value) > CONTACT_LIMIT or any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise ModuleError(f"контакт — один рядок до {CONTACT_LIMIT} символів")
    return value


def licensed_skills(catalog: dict, bought: list[str]) -> set[str]:
    skills = set(catalog["base"]["skills"])
    for module in catalog["modules"]:
        if module["id"] in bought:
            skills.update(module["skills"])
    return skills


def all_catalog_skills(catalog: dict) -> set[str]:
    skills = set(catalog["base"]["skills"])
    for module in catalog["modules"]:
        skills.update(module["skills"])
    return skills


def blocked_checks(catalog: dict, bought: list[str]) -> list[str]:
    allowed = set(catalog["base"]["checks"])
    owned = set()
    for module in catalog["modules"]:
        owned.update(module["checks"])
        if module["id"] in bought:
            allowed.update(module["checks"])
    return sorted(owned - allowed)


def kit_module_owners(catalog: dict) -> dict[str, str]:
    owners: dict[str, str] = {}
    for module in catalog["modules"]:
        for folder in module["kitModules"]:
            if folder in owners:
                raise ModuleError(f"каталог модулів: папка {folder} належить двом модулям")
            owners[folder] = module["id"]
    return owners


def google_services(catalog: dict, bought: list[str]) -> tuple[list[str], dict[str, list[str]]]:
    """Google services the bought modules open, and which modules open each one.

    Three paid modules share one Google sign-in; gog refuses a service no bought module opens.
    """
    providers: dict[str, list[str]] = {}
    for module in catalog["modules"]:
        for service in module.get("googleServices", []):
            providers.setdefault(service, []).append(module["id"])
    allowed = sorted(service for service, ids in providers.items() if set(ids) & set(bought))
    return allowed, {service: providers[service] for service in sorted(providers)}


def render_licence(catalog: dict, bought: list[str], contact: str) -> dict:
    owners = kit_module_owners(catalog)
    allowed, providers = google_services(catalog, bought)
    entry = lambda module: {"id": module["id"], "name": module["name"], "pitch": module["pitch"]}  # noqa: E731
    return {
        "schemaVersion": 1,
        "kind": "novsky-modules-licence",
        "contact": check_contact(contact),
        "base": {"name": catalog["base"]["name"], "includes": list(catalog["base"]["includes"])},
        "bought": [entry(module) for module in catalog["modules"] if module["id"] in bought],
        "notBought": [entry(module) for module in catalog["modules"] if module["id"] not in bought],
        "kitModules": owners,
        "blockedKitModules": sorted(folder for folder, owner in owners.items() if owner not in bought),
        "blockedChecks": blocked_checks(catalog, bought),
        "googleServices": allowed,
        "googleServiceModules": providers,
        "issuedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def filtered_policy(policy: dict, catalog: dict, bought: list[str]) -> dict:
    """Ті самі managed, але selected — лише база й куплене.

    reconcile-managed-skills.py сам знімає незмінену навичку, яка вийшла з
    selected, і повертає її, коли ліцензія знову її вибирає.
    """
    keep = licensed_skills(catalog, bought)
    result = dict(policy)
    result["selected"] = [name for name in policy["selected"] if name in keep]
    if "preservedAbsent" in policy:
        result["preservedAbsent"] = [name for name in policy["preservedAbsent"] if name in keep]
        if not result["preservedAbsent"]:
            result.pop("preservedAbsent")
    return result


def filtered_runtime(runtime: dict, catalog: dict, bought: list[str]) -> dict:
    """Той самий runtime.json, але без перевірок онбордингу некуплених модулів.

    onboarding-status читає списки перевірок із встановленої копії; сам помічник
    закріплений за контрольною сумою (docs/agent-connections-readiness.json), тому
    обмеження живе тут, а не в ньому.
    """
    blocked = set(blocked_checks(catalog, bought))
    result = dict(runtime)
    for field in ("requiredChecks", "optionalChecks"):
        if isinstance(runtime.get(field), list):
            result[field] = [name for name in runtime[field] if name not in blocked]
    return result


def uncovered_skills(policy: dict, catalog: dict) -> list[str]:
    """Навички комплекту, яких немає ні в базі, ні в жодному модулі."""
    return sorted(set(policy.get("selected", [])) - all_catalog_skills(catalog))


def licence_path(user: str | None = None) -> Path:
    import pwd
    return LICENCE_DIR / f"{user or pwd.getpwuid(os.getuid()).pw_name}.json"


def read_licence(path: Path | None = None) -> dict | None:
    """None — давній агент без ліцензії. Пошкоджений файл не відкриває нічого."""
    target = path or licence_path()
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        raw = ""
    try:
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("kind") != "novsky-modules-licence":
            raise ValueError
        return data
    except ValueError:
        return {
            "schemaVersion": 1, "kind": "novsky-modules-licence", "contact": "", "damaged": True,
            "base": {"name": "База", "includes": []}, "bought": [], "notBought": [],
            "kitModules": {}, "blockedKitModules": [], "blockedChecks": [],
            "googleServices": [], "googleServiceModules": {},
        }


def contact_text(licence: dict) -> str:
    return (licence.get("contact") or "").strip() or CONTACT_FALLBACK


def _write_atomic(path: Path, data: dict, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="product_modules.py")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "render", "policy", "runtime"):
        command = commands.add_parser(name)
        command.add_argument("--catalog", required=True)
        command.add_argument("--modules", required=True)
        if name in ("validate", "render"):
            command.add_argument("--contact", default="")
        if name in ("render", "policy", "runtime"):
            command.add_argument("--out", required=True)
        if name == "policy":
            command.add_argument("--policy", required=True)
        if name == "runtime":
            command.add_argument("--runtime", required=True)
    args = parser.parse_args(argv)
    try:
        catalog = load_catalog(args.catalog)
        bought = parse_modules(args.modules, catalog)
        if args.command == "validate":
            check_contact(args.contact)
            print(",".join(bought))
        elif args.command == "render":
            _write_atomic(Path(args.out), render_licence(catalog, bought, args.contact), 0o644)
        elif args.command == "runtime":
            runtime = json.loads(Path(args.runtime).read_text(encoding="utf-8"))
            _write_atomic(Path(args.out), filtered_runtime(runtime, catalog, bought), 0o600)
        else:
            policy = json.loads(Path(args.policy).read_text(encoding="utf-8"))
            missing = uncovered_skills(policy, catalog)
            if missing:
                raise ModuleError(f"навички без модуля в каталозі: {', '.join(missing)}")
            _write_atomic(Path(args.out), filtered_policy(policy, catalog, bought), 0o600)
    except (ModuleError, OSError, ValueError) as error:
        print(f"FATAL: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
