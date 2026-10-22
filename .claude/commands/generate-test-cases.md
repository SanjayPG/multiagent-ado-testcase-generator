Generate ADO test cases for the given PBI IDs.

Usage: /generate-test-cases --pbis 123,456 --context hld,refinement
       /generate-test-cases --pbis 123,456 --context hld --hld-file path/to/other-hld.md
       (--hld-file / --regression-file use that file instead of the default one in context/)

Read CLAUDE.md and follow the generate-test-cases execution plan exactly.
$ARGUMENTS contains everything the user typed after /generate-test-cases.
