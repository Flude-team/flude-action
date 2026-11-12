# tools

## doxyfile_to_flude.py

Turns the settings of a Doxyfile into a block for the Flude project settings file `.flude.yml`. It is a
separate script (Python 3.9 or newer, standard library only), not part of the Flude service or binary.

```text
python doxyfile_to_flude.py Doxyfile                       # print the block; the report goes to stderr
python doxyfile_to_flude.py Doxyfile --append .flude.yml   # add the block to the file (created if missing)
```

- The Doxyfile is only read, never changed. `--append` keeps everything already in `.flude.yml` and leaves a
  setting it already has alone (the report says so).
- Only settings the Doxyfile sets itself are written. Doxyfiles made by `doxygen -g` list every key, so such
  a file produces more settings than one written by hand; check the result before you commit it.
- Relative paths are read from the Doxyfile's directory, or from the repository root when more of them exist
  there (a Doxyfile in `doc/` run from the root). `--base DIR` and `--root DIR` override both.
- Keys without a Flude setting (`EXPAND_AS_DEFINED`, `EXTRACT_ALL`, `HIDE_*`, graphs, output formats, ...)
  are listed as "not transferred"; this is not an error.

| Doxyfile | `.flude.yml` |
| --- | --- |
| `INPUT` | `include_dirs` |
| `EXCLUDE` | `exclude_dirs` |
| `FILE_PATTERNS` | `include_patterns` (not copied when it is Doxygen's default list) |
| `EXCLUDE_PATTERNS` | `exclude_patterns` |
| `PREDEFINED` | `defines` |
| `INCLUDE_PATH` | `include_paths` |
| `EXTRACT_PRIVATE = YES` | `include_private: true` |
| `EXTRACT_ANON_NSPACES` | `extract_anon_namespaces` |
| `WARN_NO_PARAMDOC` | `warn_no_paramdoc` |
| `EXCLUDE_SYMBOLS` | `exclude_symbols` |

Tests: `python -m unittest discover tools` (PyYAML is used only to re-read the output, and those tests are
skipped without it).
