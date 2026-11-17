# Dash Stacks

![-0 cert](https://cert.neg-zero.com/crW7769)

Ever wished GNOME let you pin folders to the dash?

Pin directories and app folders with native dock buttons and stack popups.
All icon tiles keep the same square size. When the dock runs out of space,
scroll horizontally instead of shrinking its icons. Edge fades show where more
items are available; Show Apps stays visible. Use the wheel, touchpad, touch,
keyboard focus or drag a pin towards an edge to scroll.


## Pin app-grid folders

Right-click an app folder and choose **Pin to Dock**, or drag it into the dock.
App folders use the same stack popup, icon picker and **Show Folder Contents**
preview toggle as directory stacks. Right-click **Unpin from Dock**, or drag the
stack back to the app grid, to restore it. Drag stacks to reorder them; dragging
back out never deletes folder contents. You can also pin a subfolder from an
existing directory stack popup by dragging it into the dock.

App-folder entries live in the existing `stacks` setting with an `appFolder` ID
in place of `path`. The earlier separate pin list is migrated automatically.
Native GNOME folder membership and search remain intact. Stacks use native dock
containers, theme states and tooltips to match ordinary pinned apps.

`tests/appFolders.js`, run by ZenPkgs' `dash-stacks-vm`, checks the actual GNOME
actors, unified popup/contents toggle, migration, DND handlers and cancellation,
normal-pin theme/tooltip parity and square bounds at normal/doubled scale.

`tests/overflow.js` also checks fixed icon and tile sizes, native-width overflow,
wheel/touchpad scrolling, focus reveal, edge scrolling, fades, scale and cleanup.
The integration test runs in an isolated GNOME VM.
