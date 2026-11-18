What the gateway serves at `http://feeds/recordings/` when the recorder has recorded nothing
yet: for each feed, a manifest naming an empty file, so a history panel returns no rows
instead of failing. Empty here, like `recorder/feeds/`; a dashboards repo brings the empty
recordings of its feeds in its `recorder/fallback/`, which `compose.dashboards.yaml` mounts
and `gateway/feeds.conf` serves after this folder.
