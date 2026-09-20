#!/usr/bin/env python3
"""Ukrainian terminal copy for the standard-library argparse surface."""

from __future__ import annotations

import argparse
from typing import Any


_TRANSLATIONS = {
    "usage: ": "використання: ",
    "positional arguments": "позиційні аргументи",
    "optional arguments": "параметри",
    "options": "параметри",
    "subcommands": "підкоманди",
    "show this help message and exit": "показати цю довідку й вийти",
    "show program's version number and exit": "показати версію програми й вийти",
    " (default: %(default)s)": " (типово: %(default)s)",
    "argument %(argument_name)s: %(message)s": "аргумент %(argument_name)s: %(message)s",
    "the following arguments are required: %s": "обов’язкові такі аргументи: %s",
    "one of the arguments %s is required": "потрібен один з аргументів %s",
    "expected one argument": "очікується одне значення",
    "expected at most one argument": "очікується не більше одного значення",
    "expected at least one argument": "очікується принаймні одне значення",
    "invalid %(type)s value: %(value)r": "некоректне значення %(type)s: %(value)r",
    "invalid choice: %(value)r (choose from %(choices)s)": (
        "неприпустиме значення: %(value)r (можливі: %(choices)s)"
    ),
    "unrecognized arguments: %s": "нерозпізнані аргументи: %s",
    "not allowed with argument %s": "не можна використовувати з аргументом %s",
    "ambiguous option: %(option)s could match %(matches)s": (
        "неоднозначний параметр %(option)s; можливі збіги: %(matches)s"
    ),
    "ignored explicit argument %r": "явно переданий аргумент %r проігноровано",
    "unexpected option string: %s": "неочікуваний параметр: %s",
    "unknown parser %(parser_name)r (choices: %(choices)s)": (
        "невідома команда %(parser_name)r (можливі: %(choices)s)"
    ),
    "argument \"-\" with mode %r": "аргумент \"-\" у режимі %r",
    "can't open '%(filename)s': %(error)s": (
        "не вдалося відкрити '%(filename)s': %(error)s"
    ),
    "%(prog)s: error: %(message)s\n": "%(prog)s: помилка: %(message)s\n",
    "%(prog)s: warning: %(message)s\n": "%(prog)s: попередження: %(message)s\n",
    "command '%(parser_name)s' is deprecated": (
        "команда '%(parser_name)s' застаріла"
    ),
    "option '%(option)s' is deprecated": "параметр '%(option)s' застарів",
    "argument '%(argument_name)s' is deprecated": (
        "аргумент '%(argument_name)s' застарів"
    ),
}


def _ukrainian(message: str) -> str:
    return _TRANSLATIONS.get(message, message)


class ArgumentParser(argparse.ArgumentParser):
    """ArgumentParser with Ukrainian stdlib headings and diagnostics."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # argparse resolves its own terminal strings lazily through this hook,
        # including while parsing and while constructing inherited subparsers.
        argparse._ = _ukrainian
        super().__init__(*args, **kwargs)


__all__ = ["ArgumentParser"]
