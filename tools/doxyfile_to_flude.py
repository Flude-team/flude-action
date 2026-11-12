#!/usr/bin/env python3
"""Turns the settings of a Doxyfile into a block for the Flude project settings file `.flude.yml`.

    python doxyfile_to_flude.py Doxyfile                    # print the block, report on stderr
    python doxyfile_to_flude.py Doxyfile --append .flude.yml  # add the block to the file

The Doxyfile is only read. With --append the settings file is created if it does not exist, nothing already in it
is changed, and a setting it already has is left alone (the report says so). Only settings the Doxyfile sets itself
are written: a key the Doxyfile does not mention is not turned into a Flude setting. Keys without a Flude
equivalent are listed in the report, they are not errors.

Standard library only (Python 3.9 or newer); the YAML is written as text.
"""

import argparse
import os
import re
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple, Union

# The service's own limits for these settings: a longer list is rejected by the job.
MAX_DEFINES = 200
MAX_DEFINE_LENGTH = 512
MAX_EXCLUDE_SYMBOLS = 200
MAX_EXCLUDE_SYMBOL_LENGTH = 512
DEFINE_RE = re.compile(r"[A-Za-z_]\w*(?:\([^()\n]*\))?(?:=[^\n]*)?")
STICKY_DEFINE_RE = re.compile(r"([A-Za-z_]\w*(?:\([^()\n]*\))?):=(.*)", re.DOTALL)
MAX_INCLUDE_DEPTH = 20
PLACEHOLDER_RE = re.compile(r"@[A-Za-z_][A-Za-z0-9_]*@")
# A list this long that names C++, Java, Python and headers is the list Doxygen writes by default (`doxygen -g`).
DEFAULT_FILE_PATTERN_MARKERS = frozenset({"*.cpp", "*.h", "*.java", "*.py"})
DEFAULT_FILE_PATTERN_MIN_LENGTH = 30

SettingValue = Union[List[str], bool]

# The order of the generated block.
OUTPUT_ORDER = (
    "include_dirs",
    "exclude_dirs",
    "include_patterns",
    "exclude_patterns",
    "include_paths",
    "defines",
    "include_private",
    "extract_anon_namespaces",
    "exclude_symbols",
)

# Doxyfile keys this tool turns into settings (or reports on); everything else is "not transferred".
HANDLED_KEYS = frozenset(
    {
        "INPUT",
        "EXCLUDE",
        "FILE_PATTERNS",
        "EXCLUDE_PATTERNS",
        "PREDEFINED",
        "INCLUDE_PATH",
        "EXTRACT_PRIVATE",
        "EXTRACT_ANON_NSPACES",
        "EXCLUDE_SYMBOLS",
        "RECURSIVE",
        "WARN_NO_PARAMDOC",
    }
)

# Why a key that is set in the Doxyfile has no Flude setting. Keys not listed here get the generic reason.
NOT_TRANSFERRED_REASONS = {
    "EXPAND_AS_DEFINED": "Flude expands every macro of the project itself, there is no list to give",
    "MACRO_EXPANSION": "Flude expands every macro of the project itself",
    "EXPAND_ONLY_PREDEF": "Flude expands every macro of the project itself",
    "ENABLE_PREPROCESSING": "the preprocessor always runs",
    "SEARCH_INCLUDES": "headers are always searched; set include_paths to give the list",
    "EXTRACT_ALL": "Flude extracts entities without documentation; there is no switch for it yet",
    "EXTRACT_STATIC": "no Flude setting",
    "EXTRACT_PACKAGE": "no Flude setting",
    "EXTRACT_LOCAL_CLASSES": "no Flude setting",
    "EXTRACT_LOCAL_METHODS": "no Flude setting",
    "HIDE_UNDOC_MEMBERS": "no Flude setting",
    "HIDE_UNDOC_CLASSES": "no Flude setting",
    "HIDE_FRIEND_COMPOUNDS": "no Flude setting",
    "HIDE_IN_BODY_DOCS": "no Flude setting",
    "HIDE_SCOPE_NAMES": "no Flude setting",
    "INTERNAL_DOCS": "no Flude setting",
    "EXTENSION_MAPPING": "the language is chosen when the job is created",
}
GENERIC_REASON = "ignored: no Flude setting"


class DoxyfileError(Exception):
    """The Doxyfile cannot be read."""


class ParsedDoxyfile:
    def __init__(self) -> None:
        self.settings = OrderedDict()  # type: Dict[str, List[str]]
        self.warnings = []  # type: List[str]


class Conversion:
    def __init__(self) -> None:
        self.settings = OrderedDict()  # type: Dict[str, SettingValue]
        self.warnings = []  # type: List[str]
        self.notes = []  # type: List[str]
        self.not_transferred = []  # type: List[Tuple[str, str]]


# ---------------------------------------------------------------------------------------------------------------------
# Reading a Doxyfile
# ---------------------------------------------------------------------------------------------------------------------

_ASSIGNMENT_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*|@[A-Za-z_]+)\s*(\+?=)\s*(.*)$", re.DOTALL)


def _strip_comment(text: str) -> str:
    """Cuts a `#` comment off, unless the `#` is inside double quotes."""
    in_quotes = False
    for i, char in enumerate(text):
        if char == '"':
            in_quotes = not in_quotes
        elif char == "#" and not in_quotes:
            return text[:i]
    return text


def _tokenize(text: str) -> List[str]:
    """Splits a value on whitespace; a double-quoted part is one token and loses its quotes."""
    tokens = []  # type: List[str]
    current = []  # type: List[str]
    in_quotes = False
    started = False
    for char in text:
        if char == '"':
            in_quotes = not in_quotes
            started = True
        elif char.isspace() and not in_quotes:
            if started:
                tokens.append("".join(current))
                current, started = [], False
        else:
            current.append(char)
            started = True
    if started:
        tokens.append("".join(current))
    return tokens


def _logical_lines(text: str) -> List[str]:
    """The lines of a Doxyfile with `\\` continuations joined and comment-only lines dropped."""
    lines = []  # type: List[str]
    buffer = ""
    for raw in text.splitlines():
        stripped = raw.rstrip()
        if not buffer and stripped.lstrip().startswith("#"):
            continue
        if stripped.endswith("\\"):
            buffer += stripped[:-1] + " "
            continue
        lines.append(buffer + stripped)
        buffer = ""
    if buffer:
        lines.append(buffer)
    return lines


def _read_into(
    path: Path,
    parsed: ParsedDoxyfile,
    stack: List[Path],
    search_dirs: List[Path],
) -> None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise DoxyfileError("cannot read {}: {}".format(path, error))
    stack.append(path.resolve())
    for line in _logical_lines(text):
        match = _ASSIGNMENT_RE.match(_strip_comment(line))
        if not match:
            continue
        key, operator, value = match.group(1).upper(), match.group(2), match.group(3)
        tokens = _tokenize(value)
        if key == "@INCLUDE_PATH":
            search_dirs.extend(path.parent / token for token in tokens)
        elif key == "@INCLUDE":
            for token in tokens:
                _include(token, path, parsed, stack, search_dirs)
        elif key.startswith("@"):
            continue
        elif operator == "+=":
            parsed.settings.setdefault(key, []).extend(tokens)
        else:
            parsed.settings[key] = tokens
    stack.pop()


def _include(name: str, current: Path, parsed: ParsedDoxyfile, stack: List[Path], search_dirs: List[Path]) -> None:
    candidates = [current.parent / name] + [d / name for d in search_dirs]
    target = next((c for c in candidates if c.is_file()), None)
    if target is None:
        parsed.warnings.append("@INCLUDE {}: file not found, its settings are missing".format(name))
        return
    if target.resolve() in stack or len(stack) >= MAX_INCLUDE_DEPTH:
        parsed.warnings.append("@INCLUDE {}: include cycle (or nesting deeper than {}), skipped".format(name, MAX_INCLUDE_DEPTH))
        return
    _read_into(target, parsed, stack, search_dirs)


def parse_doxyfile(path: Union[str, Path]) -> ParsedDoxyfile:
    """Reads a Doxyfile (with @INCLUDE files) into {KEY: [tokens]}. Later lines win; `+=` appends."""
    parsed = ParsedDoxyfile()
    _read_into(Path(path), parsed, [], [])
    return parsed


# ---------------------------------------------------------------------------------------------------------------------
# Converting the settings
# ---------------------------------------------------------------------------------------------------------------------


def _root_relative(
    token: str, base: Path, root: Path, key: str, warnings: List[str], notes: List[str], check_file: bool
) -> Optional[str]:
    """A path from the Doxyfile as a path relative to the repository root, or None (with a warning) when it
    cannot be one. The root itself is returned as ''. Relative paths are read from `base`."""
    if "$(" in token:
        warnings.append("{}: {!r} contains an environment variable, which is not expanded; skipped".format(key, token))
        return None
    if PLACEHOLDER_RE.search(token):
        warnings.append("{}: {!r} contains a configure-time placeholder that is not substituted; skipped".format(key, token))
        return None
    path = token.replace("\\", "/")
    if os.path.isabs(path) or re.match(r"^[A-Za-z]:", path):
        warnings.append("{}: {!r} is an absolute path and cannot be used in the repository; skipped".format(key, token))
        return None
    full = os.path.normpath(os.path.join(str(base), path))
    try:
        relative = os.path.relpath(full, str(root)).replace(os.sep, "/")
    except ValueError:
        warnings.append("{}: {!r} is outside the repository; skipped".format(key, token))
        return None
    if relative == ".." or relative.startswith("../"):
        warnings.append("{}: {!r} is outside the repository; skipped".format(key, token))
        return None
    if check_file and os.path.isfile(full):
        warnings.append("{}: {!r} is a file; Flude takes directories here (use a pattern or the parent directory); skipped".format(key, token))
        return None
    if not os.path.exists(full):
        warnings.append("{}: {!r} does not exist (read from {}); kept as written, check --base".format(key, token, base))
    return "" if relative == "." else relative


def _directories(
    tokens: Sequence[str], key: str, base: Path, root: Path, warnings: List[str], notes: List[str]
) -> List[str]:
    result = []  # type: List[str]
    for token in tokens:
        relative = _root_relative(token, base, root, key, warnings, notes, check_file=True)
        if relative and relative not in result:
            result.append(relative)
    return result


def _is_default_file_patterns(patterns: Sequence[str]) -> bool:
    return len(patterns) >= DEFAULT_FILE_PATTERN_MIN_LENGTH and DEFAULT_FILE_PATTERN_MARKERS <= set(patterns)


def _choose_base(settings: Dict[str, List[str]], base: Path, root: Path, notes: List[str]) -> Path:
    """The directory the paths of this Doxyfile are read from. Normally `base`; when more of them exist from the
    repository root than from `base` (a Doxyfile in doc/ that Doxygen runs from the root, INPUT = src), the root."""
    if base == root:
        return base
    tokens = [
        t
        for key in ("INPUT", "EXCLUDE", "INCLUDE_PATH")
        for t in settings.get(key, [])
        if "$(" not in t and not PLACEHOLDER_RE.search(t) and not os.path.isabs(t)
    ]
    from_base = [t for t in tokens if os.path.exists(os.path.join(str(base), t))]
    from_root = [t for t in tokens if os.path.exists(os.path.join(str(root), t))]
    if len(from_root) > len(from_base):
        notes.append(
            "paths in the Doxyfile were read from the repository root, where more of them exist than next to the "
            "Doxyfile (for example {!r}); use --base to read them from another directory".format(from_root[0])
        )
        return root
    return base


def _flag(parsed: ParsedDoxyfile, key: str, warnings: List[str]) -> Optional[bool]:
    tokens = parsed.settings.get(key)
    if tokens is None:
        return None
    value = " ".join(tokens).strip().upper()
    if value in ("YES", "NO"):
        return value == "YES"
    warnings.append("{} = {}: expected YES or NO; ignored".format(key, " ".join(tokens)))
    return None


def _defines(tokens: Sequence[str], warnings: List[str]) -> List[str]:
    result = []  # type: List[str]
    for token in tokens:
        if "$(" in token:
            warnings.append("PREDEFINED: {!r} contains an environment variable, which is not expanded; skipped".format(token))
            continue
        sticky = STICKY_DEFINE_RE.fullmatch(token)
        entry = token
        if sticky:
            entry = "{}={}".format(sticky.group(1), sticky.group(2))
            warnings.append("PREDEFINED: {!r} (a macro that cannot be redefined) is written as {!r}".format(token, entry))
        if len(entry) > MAX_DEFINE_LENGTH:
            warnings.append("PREDEFINED: {!r}... is longer than {} characters; skipped".format(entry[:40], MAX_DEFINE_LENGTH))
        elif not DEFINE_RE.fullmatch(entry):
            warnings.append("PREDEFINED: {!r} is not NAME, NAME=VALUE or NAME(args)=VALUE; skipped".format(token))
        elif entry not in result:
            result.append(entry)
    if len(result) > MAX_DEFINES:
        warnings.append("PREDEFINED: at most {} entries are accepted, the first {} are kept".format(MAX_DEFINES, MAX_DEFINES))
        result = result[:MAX_DEFINES]
    return result


def _symbols(tokens: Sequence[str], warnings: List[str]) -> List[str]:
    result = []  # type: List[str]
    for token in tokens:
        if not token.strip():
            # `EXCLUDE_SYMBOLS = ""` is an empty list to Doxygen (checked with 1.9.8); the worker rejects an empty entry.
            continue
        if len(token) > MAX_EXCLUDE_SYMBOL_LENGTH:
            warnings.append("EXCLUDE_SYMBOLS: {!r}... is longer than {} characters; skipped".format(token[:40], MAX_EXCLUDE_SYMBOL_LENGTH))
        elif token not in result:
            result.append(token)
    if len(result) > MAX_EXCLUDE_SYMBOLS:
        warnings.append("EXCLUDE_SYMBOLS: at most {} entries are accepted, the first {} are kept".format(MAX_EXCLUDE_SYMBOLS, MAX_EXCLUDE_SYMBOLS))
        result = result[:MAX_EXCLUDE_SYMBOLS]
    return result


def convert(parsed: ParsedDoxyfile, root: Path, base: Path) -> Conversion:
    """Doxyfile settings as Flude settings. `base` is the directory the Doxyfile's relative paths are read from
    (where Doxygen was run), `root` the repository root the `.flude.yml` lives in."""
    root, base = Path(root).resolve(), Path(base).resolve()
    result = Conversion()
    result.warnings.extend(parsed.warnings)
    settings = parsed.settings
    base = _choose_base(settings, base, root, result.notes)

    def put(key: str, value: SettingValue) -> None:
        if value or value is False:
            result.settings[key] = value

    put("include_dirs", _directories(settings.get("INPUT", []), "INPUT", base, root, result.warnings, result.notes))
    put("exclude_dirs", _directories(settings.get("EXCLUDE", []), "EXCLUDE", base, root, result.warnings, result.notes))
    patterns = settings.get("FILE_PATTERNS", [])
    if _is_default_file_patterns(patterns):
        result.notes.append(
            "FILE_PATTERNS is Doxygen's default list (generated Doxyfiles repeat it), not copied: Flude's own "
            "default for the language applies"
        )
    else:
        put("include_patterns", [p if "/" in p else "**/" + p for p in patterns])
    put("exclude_patterns", list(settings.get("EXCLUDE_PATTERNS", [])))
    put(
        "include_paths",
        _directories(settings.get("INCLUDE_PATH", []), "INCLUDE_PATH", base, root, result.warnings, result.notes),
    )
    put("defines", _defines(settings.get("PREDEFINED", []), result.warnings))
    if _flag(parsed, "EXTRACT_PRIVATE", result.warnings):
        result.settings["include_private"] = True
    anon = _flag(parsed, "EXTRACT_ANON_NSPACES", result.warnings)
    if anon is not None:
        result.settings["extract_anon_namespaces"] = anon
    elif "EXTRACT_ANON_NSPACES" not in settings:
        result.notes.append(
            "EXTRACT_ANON_NSPACES is not set: Doxygen's default NO hides anonymous namespaces; Flude extracts "
            "them unless extract_anon_namespaces is false"
        )
    paramdoc = _flag(parsed, "WARN_NO_PARAMDOC", result.warnings)
    if paramdoc is not None:
        result.settings["warn_no_paramdoc"] = paramdoc
    elif "WARN_NO_PARAMDOC" not in settings:
        result.notes.append(
            "WARN_NO_PARAMDOC is not set: Doxygen's default NO does not warn about undocumented parameters and return "
            "values; the Flude audit report lists them unless warn_no_paramdoc is false"
        )
    put("exclude_symbols", _symbols(settings.get("EXCLUDE_SYMBOLS", []), result.warnings))
    if "EXCLUDE_SYMBOLS" in settings:
        result.notes.append(
            "EXCLUDE_SYMBOLS: Flude matches the qualified name of a member too, Doxygen only its bare name, so a "
            "pattern such as ns::api hides just that one, and ns::Tmpl<int> hides a single specialization"
        )
    recursive = _flag(parsed, "RECURSIVE", result.warnings)
    if not recursive:
        result.notes.append(
            "RECURSIVE is NO or not set: Doxygen reads only the top level of each INPUT directory, Flude always "
            "scans directories recursively (exclude_dirs and exclude_patterns narrow it)"
        )
    for key in settings:
        if key not in HANDLED_KEYS:
            result.not_transferred.append((key, NOT_TRANSFERRED_REASONS.get(key, GENERIC_REASON)))
    return result


# ---------------------------------------------------------------------------------------------------------------------
# Writing the block
# ---------------------------------------------------------------------------------------------------------------------

_PLAIN_RE = re.compile(r"[A-Za-z0-9_./][A-Za-z0-9_./-]*")
_NUMBER_RE = re.compile(r"[-+]?(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_RESERVED = {"true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"}


def yaml_scalar(text: str) -> str:
    """A string as a YAML scalar: plain when YAML reads it back unchanged, single-quoted otherwise."""
    if _PLAIN_RE.fullmatch(text) and text.lower() not in _RESERVED and not _NUMBER_RE.fullmatch(text):
        return text
    return "'" + text.replace("'", "''") + "'"


def render_yaml(settings: Dict[str, SettingValue]) -> str:
    lines = []  # type: List[str]
    for key in OUTPUT_ORDER:
        if key not in settings:
            continue
        value = settings[key]
        if isinstance(value, bool):
            lines.append("{}: {}".format(key, "true" if value else "false"))
        else:
            lines.append(key + ":")
            lines.extend("  - " + yaml_scalar(item) for item in value)
    return "\n".join(lines) + "\n" if lines else ""


# ---------------------------------------------------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------------------------------------------------

_TOP_LEVEL_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:", re.MULTILINE)


def _print_report(source: Path, result: Conversion, skipped: Sequence[str], out) -> None:
    written = [key for key in OUTPUT_ORDER if key in result.settings and key not in skipped]
    print("Doxyfile {}: {} setting(s) converted: {}".format(source, len(written), ", ".join(written) or "none"), file=out)
    for key in skipped:
        print("  {} is already in the settings file: kept your value".format(key), file=out)
    for warning in result.warnings:
        print("  warning: {}".format(warning), file=out)
    for note in result.notes:
        print("  note: {}".format(note), file=out)
    if result.not_transferred:
        specific = [(k, r) for k, r in result.not_transferred if r != GENERIC_REASON]
        generic = [k for k, r in result.not_transferred if r == GENERIC_REASON]
        print("  not transferred:", file=out)
        for key, reason in specific:
            print("    {}: {}".format(key, reason), file=out)
        if generic:
            print("    {} other key(s), {}: {}".format(len(generic), GENERIC_REASON.replace("ignored: ", ""), ", ".join(generic)), file=out)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert the settings of a Doxyfile into a block for the Flude project settings file .flude.yml."
    )
    parser.add_argument("doxyfile", help="the Doxyfile to read (it is never modified)")
    parser.add_argument("--append", metavar="FILE", help="add the block to this .flude.yml (created if missing)")
    parser.add_argument("--root", metavar="DIR", help="repository root; default: the directory of --append FILE, else the current directory")
    parser.add_argument("--base", metavar="DIR", help="directory the Doxyfile's relative paths are read from (where Doxygen was run); default: the directory of the Doxyfile")
    args = parser.parse_args(argv)

    doxyfile = Path(args.doxyfile)
    try:
        parsed = parse_doxyfile(doxyfile)
    except DoxyfileError as error:
        print("error: {}".format(error), file=sys.stderr)
        return 2
    target = Path(args.append) if args.append else None
    root = Path(args.root) if args.root else (target.resolve().parent if target else Path.cwd())
    base = Path(args.base) if args.base else doxyfile.resolve().parent
    result = convert(parsed, root, base)

    skipped = []  # type: List[str]
    settings = OrderedDict(result.settings)
    if target is None:
        _print_report(doxyfile, result, skipped, sys.stderr)
        sys.stdout.write(render_yaml(settings))
        return 0

    existing = target.read_text(encoding="utf-8") if target.is_file() else None
    if existing is not None:
        present = set(_TOP_LEVEL_KEY_RE.findall(existing))
        skipped = [key for key in settings if key in present]
        for key in skipped:
            del settings[key]
    block = render_yaml(settings)
    _print_report(doxyfile, result, skipped, sys.stderr)
    if existing is None:
        target.write_text("version: 1\n" + block, encoding="utf-8")
    elif block:
        separator = "" if existing.endswith("\n") or not existing else "\n"
        header = "\n# Added by doxyfile_to_flude.py from {}\n".format(doxyfile.name)
        target.write_text(existing + separator + header + block, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
