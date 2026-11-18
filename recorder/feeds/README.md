Feeds the recorder keeps, one `<feed>.sql` each (see `images/recorder/recorder.py` for the
headers a feed takes). Empty here on purpose: Pacha's own dashboards need no recording. A
dashboards repo brings its feeds in its own `recorder/feeds/`, which `compose.dashboards.yaml`
mounts beside this folder; Ubica's are in
[pacha-dashboards](https://github.com/ubica-ecuador/pacha-dashboards/tree/main/recorder/feeds).
The recorder runs with the compose profile `recorder`, and stops with "no feeds" when it has
none.
