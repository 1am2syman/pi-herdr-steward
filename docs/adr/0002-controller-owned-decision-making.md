# Keep orchestration decisions with the controller

The first version supports explicitly started Runs containing multiple independent builder/reviewer pairs. Existing agents may continue while the controlling Pi session is unavailable, but new dispatch, review, and integration decisions pause until the controller returns and reconciles state; no separate autonomous daemon will be introduced.
