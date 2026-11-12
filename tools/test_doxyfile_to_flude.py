"""Tests for doxyfile_to_flude.py (standard library only; run with `python -m unittest discover tools`)."""

import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import doxyfile_to_flude as d  # noqa: E402

try:
    import yaml  # type: ignore
except ImportError:  # the tool never needs it; a few tests only use it to re-read the output
    yaml = None


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve()

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def convert(self, text, name="Doxyfile", root=None, base=None):
        path = self.write(name, text)
        parsed = d.parse_doxyfile(path)
        return d.convert(parsed, root or self.root, base or path.parent)


class ParseTests(TempDirTest):
    def test_values_continuations_comments_and_quotes(self):
        path = self.write(
            "Doxyfile",
            "# a comment\n"
            "PROJECT_NAME = \"My Project\"  # trailing comment\n"
            "INPUT = src \\\n"
            "        include \\\n"
            "        \"dir with space\"\n"
            "FILE_PATTERNS=*.h *.hpp\n",
        )
        settings = d.parse_doxyfile(path).settings
        self.assertEqual(settings["PROJECT_NAME"], ["My Project"])
        self.assertEqual(settings["INPUT"], ["src", "include", "dir with space"])
        self.assertEqual(settings["FILE_PATTERNS"], ["*.h", "*.hpp"])

    def test_hash_inside_quotes_is_not_a_comment(self):
        path = self.write("Doxyfile", 'PREDEFINED = "TAG=#x" OTHER\n')
        self.assertEqual(d.parse_doxyfile(path).settings["PREDEFINED"], ["TAG=#x", "OTHER"])

    def test_plus_equals_appends_and_equals_replaces(self):
        path = self.write("Doxyfile", "INPUT = a\nINPUT += b c\nEXCLUDE = x\nEXCLUDE = y\n")
        settings = d.parse_doxyfile(path).settings
        self.assertEqual(settings["INPUT"], ["a", "b", "c"])
        self.assertEqual(settings["EXCLUDE"], ["y"])

    def test_include_is_relative_to_the_including_file_and_later_lines_win(self):
        self.write("conf/base.dox", "INPUT = from_base\nRECURSIVE = NO\n")
        path = self.write("conf/Doxyfile", "@INCLUDE = base.dox\nRECURSIVE = YES\n")
        parsed = d.parse_doxyfile(path)
        self.assertEqual(parsed.settings["INPUT"], ["from_base"])
        self.assertEqual(parsed.settings["RECURSIVE"], ["YES"])

    def test_include_cycles_and_missing_files_are_warnings_not_crashes(self):
        self.write("a.dox", "@INCLUDE = b.dox\n")
        self.write("b.dox", "@INCLUDE = a.dox\nINPUT = ok\n")
        parsed = d.parse_doxyfile(self.root / "a.dox")
        self.assertEqual(parsed.settings["INPUT"], ["ok"])
        self.assertTrue(any("cycle" in w for w in parsed.warnings))
        path = self.write("Doxyfile", "@INCLUDE = nothing_here.dox\nINPUT = src\n")
        parsed = d.parse_doxyfile(path)
        self.assertEqual(parsed.settings["INPUT"], ["src"])
        self.assertTrue(any("nothing_here.dox" in w and "not found" in w for w in parsed.warnings))

    def test_unreadable_doxyfile_raises_a_clear_error(self):
        with self.assertRaises(d.DoxyfileError):
            d.parse_doxyfile(self.root / "missing")


class PathMappingTests(TempDirTest):
    def test_input_and_exclude_become_root_relative_directories(self):
        (self.root / "src").mkdir()
        (self.root / "docs").mkdir()
        result = self.convert("INPUT = ../src\nEXCLUDE = ../src/detail ../src/third_party/\n", name="docs/Doxyfile")
        self.assertEqual(result.settings["include_dirs"], ["src"])
        self.assertEqual(result.settings["exclude_dirs"], ["src/detail", "src/third_party"])

    def test_the_repository_root_and_an_empty_input_mean_the_default(self):
        self.assertNotIn("include_dirs", self.convert("INPUT = .\n").settings)
        self.assertNotIn("include_dirs", self.convert("INPUT =\n").settings)

    def test_absolute_outside_root_and_file_entries_are_skipped_with_a_warning(self):
        (self.root / "README.md").write_text("x", encoding="utf-8")
        absolute = str(self.root.parent / "elsewhere")
        result = self.convert(f"INPUT = src README.md ../outside {absolute}\n")
        self.assertEqual(result.settings["include_dirs"], ["src"])
        joined = "\n".join(result.warnings)
        self.assertIn("README.md", joined)
        self.assertIn("../outside", joined)
        self.assertIn("absolute", joined)

    def test_the_base_directory_can_differ_from_the_doxyfile_directory(self):
        (self.root / "build").mkdir()
        self.write("build/Doxyfile", "INPUT = src\n")
        parsed = d.parse_doxyfile(self.root / "build" / "Doxyfile")
        result = d.convert(parsed, self.root, self.root)  # doxygen was run from the repository root
        self.assertEqual(result.settings["include_dirs"], ["src"])

    def test_include_path(self):
        result = self.convert("INCLUDE_PATH = include ../other\n", name="Doxyfile")
        self.assertEqual(result.settings["include_paths"], ["include"])
        self.assertTrue(any("../other" in w for w in result.warnings))

    def test_an_environment_variable_in_a_path_is_not_guessed(self):
        result = self.convert("INPUT = $(SRC_DIR)/lib src\n")
        self.assertEqual(result.settings["include_dirs"], ["src"])
        self.assertTrue(any("$(SRC_DIR)" in w for w in result.warnings))


class RealWorldPathTests(TempDirTest):
    def test_a_path_that_exists_only_from_the_repository_root_is_read_from_there(self):
        # bitcoin: the Doxyfile is in doc/, Doxygen is run from the repository root, INPUT = src.
        (self.root / "src").mkdir()
        result = self.convert("INPUT = src\n", name="doc/Doxyfile")
        self.assertEqual(result.settings["include_dirs"], ["src"])
        self.assertTrue(any("repository root" in n and "src" in n for n in result.notes))

    def test_a_missing_directory_is_kept_with_a_warning(self):
        result = self.convert("INPUT = generated/headers\n")
        self.assertEqual(result.settings["include_dirs"], ["generated/headers"])
        self.assertTrue(any("generated/headers" in w and "does not exist" in w for w in result.warnings))

    def test_configure_placeholders_are_not_guessed(self):
        result = self.convert("INPUT = @abs_top_srcdir@/src src\n")
        self.assertEqual(result.settings["include_dirs"], ["src"])
        self.assertTrue(any("@abs_top_srcdir@" in w for w in result.warnings))

    def test_doxygens_default_file_pattern_list_is_not_copied(self):
        default = (
            "*.c *.cc *.cxx *.cpp *.c++ *.java *.ii *.ixx *.ipp *.i++ *.inl *.idl *.ddl *.odl *.h *.hh *.hxx "
            "*.hpp *.h++ *.l *.cs *.d *.php *.php4 *.php5 *.phtml *.inc *.m *.markdown *.md *.mm *.dox *.py "
            "*.pyw *.f90 *.f95 *.f03 *.f08 *.f18 *.f *.for *.vhd *.vhdl *.ucf *.qsf *.ice"
        )
        result = self.convert("FILE_PATTERNS = " + default + "\n")
        self.assertNotIn("include_patterns", result.settings)
        self.assertTrue(any("FILE_PATTERNS" in n and "default" in n for n in result.notes))


class PatternAndDefineTests(TempDirTest):
    def test_file_patterns_match_at_any_depth_and_exclude_patterns_are_verbatim(self):
        result = self.convert("FILE_PATTERNS = *.h *.hpp sub/*.inl\nEXCLUDE_PATTERNS = */test/* */build/*\n")
        self.assertEqual(result.settings["include_patterns"], ["**/*.h", "**/*.hpp", "sub/*.inl"])
        self.assertEqual(result.settings["exclude_patterns"], ["*/test/*", "*/build/*"])

    def test_predefined_forms(self):
        result = self.convert('PREDEFINED = FEATURE LEVEL=2 EXPORT(x)= STICKY:=1 "TEXT=a b" 1bad\n')
        self.assertEqual(
            result.settings["defines"], ["FEATURE", "LEVEL=2", "EXPORT(x)=", "STICKY=1", "TEXT=a b"]
        )
        joined = "\n".join(result.warnings)
        self.assertIn("STICKY:=1", joined)
        self.assertIn("1bad", joined)

    def test_predefined_limits_follow_the_service(self):
        many = " ".join(f"M{i}" for i in range(d.MAX_DEFINES + 5))
        result = self.convert(f"PREDEFINED = {many}\n")
        self.assertEqual(len(result.settings["defines"]), d.MAX_DEFINES)
        self.assertTrue(any("at most" in w for w in result.warnings))
        long_entry = "A=" + "x" * d.MAX_DEFINE_LENGTH
        result = self.convert(f"PREDEFINED = SHORT {long_entry}\n")
        self.assertEqual(result.settings["defines"], ["SHORT"])


class SwitchTests(TempDirTest):
    def test_extract_private_only_when_yes(self):
        self.assertIs(self.convert("EXTRACT_PRIVATE = YES\n").settings["include_private"], True)
        self.assertNotIn("include_private", self.convert("EXTRACT_PRIVATE = NO\n").settings)
        self.assertNotIn("include_private", self.convert("").settings)

    def test_extract_anon_namespaces_is_written_when_the_doxyfile_sets_it(self):
        self.assertIs(self.convert("EXTRACT_ANON_NSPACES = YES\n").settings["extract_anon_namespaces"], True)
        self.assertIs(self.convert("EXTRACT_ANON_NSPACES = NO\n").settings["extract_anon_namespaces"], False)
        absent = self.convert("")
        self.assertNotIn("extract_anon_namespaces", absent.settings)
        self.assertTrue(any("EXTRACT_ANON_NSPACES" in n for n in absent.notes))

    def test_warn_no_paramdoc_is_written_when_the_doxyfile_sets_it(self):
        self.assertIs(self.convert("WARN_NO_PARAMDOC = YES\n").settings["warn_no_paramdoc"], True)
        self.assertIs(self.convert("WARN_NO_PARAMDOC = NO\n").settings["warn_no_paramdoc"], False)
        absent = self.convert("")
        self.assertNotIn("warn_no_paramdoc", absent.settings)
        self.assertTrue(any("WARN_NO_PARAMDOC" in n for n in absent.notes))
        set_to_no = self.convert("WARN_NO_PARAMDOC = NO\n")
        self.assertNotIn("WARN_NO_PARAMDOC", [key for key, _ in set_to_no.not_transferred])

    def test_a_value_that_is_not_yes_or_no_is_a_warning(self):
        result = self.convert("EXTRACT_PRIVATE = MAYBE\n")
        self.assertNotIn("include_private", result.settings)
        self.assertTrue(any("EXTRACT_PRIVATE" in w and "MAYBE" in w for w in result.warnings))

    def test_exclude_symbols_are_passed_on_and_the_difference_is_noted(self):
        result = self.convert("EXCLUDE_SYMBOLS = ns::detail *::impl\n")
        self.assertEqual(result.settings["exclude_symbols"], ["ns::detail", "*::impl"])
        self.assertTrue(any("EXCLUDE_SYMBOLS" in n for n in result.notes))

    def test_an_empty_exclude_symbols_entry_is_dropped_like_doxygen_does(self):
        # Doxygen 1.9.8: `EXCLUDE_SYMBOLS = ""` excludes nothing; the worker rejects `exclude_symbols: ['']`.
        for text in ('EXCLUDE_SYMBOLS = ""\n', 'EXCLUDE_SYMBOLS = "  "\n', "EXCLUDE_SYMBOLS =\n"):
            result = self.convert(text)
            self.assertNotIn("exclude_symbols", result.settings, text)
            self.assertEqual([], [w for w in result.warnings if "EXCLUDE_SYMBOLS" in w], text)
        mixed = self.convert('EXCLUDE_SYMBOLS = "" ns::detail ""\n')
        self.assertEqual(mixed.settings["exclude_symbols"], ["ns::detail"])

    def test_recursive_other_than_yes_is_noted(self):
        self.assertTrue(any("RECURSIVE" in n for n in self.convert("RECURSIVE = NO\n").notes))
        self.assertTrue(any("RECURSIVE" in n for n in self.convert("").notes))
        self.assertFalse(any("RECURSIVE" in n for n in self.convert("RECURSIVE = YES\n").notes))

    def test_keys_without_an_equivalent_are_listed_with_a_reason(self):
        result = self.convert("EXPAND_AS_DEFINED = FOO\nEXTRACT_ALL = YES\nGENERATE_LATEX = NO\nHAVE_DOT = YES\n")
        by_key = dict(result.not_transferred)
        self.assertIn("EXPAND_AS_DEFINED", by_key)
        self.assertIn("EXTRACT_ALL", by_key)
        self.assertIn("expands", by_key["EXPAND_AS_DEFINED"])
        self.assertIn("GENERATE_LATEX", by_key)  # generic: ignored
        self.assertNotIn("INPUT", by_key)

    def test_an_empty_doxyfile_converts_to_nothing(self):
        self.assertEqual(dict(self.convert("").settings), {})


class RenderTests(unittest.TestCase):
    def test_scalars_are_quoted_when_yaml_would_misread_them(self):
        self.assertEqual(d.yaml_scalar("src/detail"), "src/detail")
        self.assertEqual(d.yaml_scalar("**/*.h"), "'**/*.h'")
        self.assertEqual(d.yaml_scalar("LEVEL=2"), "'LEVEL=2'")
        self.assertEqual(d.yaml_scalar("it's"), "'it''s'")
        self.assertEqual(d.yaml_scalar("true"), "'true'")
        self.assertEqual(d.yaml_scalar("123"), "'123'")
        self.assertEqual(d.yaml_scalar("*::impl"), "'*::impl'")

    def test_render_lists_booleans_and_order(self):
        text = d.render_yaml({"exclude_symbols": ["a::b"], "include_dirs": ["src"], "include_private": True})
        self.assertEqual(
            text,
            "include_dirs:\n  - src\ninclude_private: true\nexclude_symbols:\n  - 'a::b'\n",
        )

    @unittest.skipIf(yaml is None, "PyYAML is only used to re-read the output")
    def test_the_output_is_valid_yaml_with_the_same_content(self):
        settings = {
            "include_dirs": ["src", "dir with space"],
            "include_patterns": ["**/*.h"],
            "defines": ["A=b c", "it's", "X(y)=1"],
            "extract_anon_namespaces": False,
            "exclude_symbols": ["*::impl", "ns::Tmpl<int>"],
        }
        self.assertEqual(yaml.safe_load(d.render_yaml(settings)), settings)


class CommandLineTests(TempDirTest):
    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = d.main([str(a) for a in argv])
        return code, out.getvalue(), err.getvalue()

    def test_prints_the_block_and_the_report(self):
        self.write("src/x.h", "")
        doxyfile = self.write("Doxyfile", "INPUT = src\nEXPAND_AS_DEFINED = FOO\n")
        code, out, err = self.run_main(doxyfile, "--root", self.root)
        self.assertEqual(code, 0)
        self.assertIn("include_dirs:\n  - src\n", out)
        self.assertIn("EXPAND_AS_DEFINED", err)

    def test_append_creates_the_file_with_a_version(self):
        doxyfile = self.write("Doxyfile", "INPUT = src\n")
        target = self.root / ".flude.yml"
        code, out, err = self.run_main(doxyfile, "--append", target)
        self.assertEqual(code, 0)
        text = target.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("version: 1\n"))
        self.assertIn("include_dirs:\n  - src\n", text)

    def test_append_keeps_existing_content_and_existing_keys(self):
        target = self.write(".flude.yml", "# mine\ninclude_dirs: [lib]\ncpp_std: c++20")  # no trailing newline
        doxyfile = self.write("Doxyfile", "INPUT = src\nFILE_PATTERNS = *.h\n")
        code, out, err = self.run_main(doxyfile, "--append", target)
        text = target.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("# mine\ninclude_dirs: [lib]\ncpp_std: c++20\n"))
        self.assertEqual(text.count("include_dirs"), 1)  # the user's value is kept, not duplicated
        self.assertIn("include_patterns:\n  - '**/*.h'\n", text)
        self.assertIn("include_dirs", err)
        self.assertIn("already", err)

    def test_the_doxyfile_is_never_modified(self):
        doxyfile = self.write("Doxyfile", "INPUT = src\n")
        before = doxyfile.read_text(encoding="utf-8")
        self.run_main(doxyfile, "--append", self.root / ".flude.yml")
        self.assertEqual(doxyfile.read_text(encoding="utf-8"), before)

    def test_a_missing_doxyfile_exits_with_2(self):
        code, out, err = self.run_main(self.root / "nope")
        self.assertEqual(code, 2)
        self.assertIn("nope", err)


if __name__ == "__main__":
    unittest.main()
