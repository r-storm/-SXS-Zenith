# Zenith guild tracker

A fan-made dashboard for the Zenith guild in Sword x Staff. It shows guild
rankings and a profile page for every member, updated weekly.

Sword x Staff and its artwork belong to its publisher. This is an unofficial
fan project.

## Adding a snapshot

1. Put the raw screenshots in `captures/<date>/` (`members`, `conquest` and,
   when captured, `profiles`). That folder is gitignored.
2. Write `data/snapshots/<date>/week.json`, plus `profiles.json` when there are
   profile captures (then run `tools/make-shots.sh <date>` for the crops).
3. Add the date to `data/snapshots.json`.

The newest date is shown by default and the calendar on the page switches
between dates. A snapshot without profile captures reuses each member's most
recent earlier one.
