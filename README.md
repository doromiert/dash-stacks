# Dash Stacks

![-0 cert](https://cert.neg-zero.com/crW7769)

Ever wished GNOME let you pin folders to the dash?

Pin directories and app folders with native dock buttons and stack popups.
All icon tiles keep the same square size. When the dock runs out of space,
scroll horizontally instead of shrinking its icons. Edge fades show where more
items are available; Show Apps stays visible. Use the wheel, touchpad, touch,
keyboard focus or drag a pin towards an edge to scroll. Touch and trackpad
scrolling glide after release and stop on fresh input; reduced motion is respected.
Inside padding and outside horizontal limits follow the vertical spacing.


## Drag files into apps

Drag a file beyond the stack popup to close Overview and continue the same
held-button drag into an application. Apps receive a normal `text/uri-list`
file drop, including correctly escaped spaces and Unicode filenames. Escape
cancels the drag. The source file stays in place; the target receives a copy
operation. App launchers, nested stacks and folders keep their dock pinning
and Shell drag behavior.

The Nix package includes a small GTK 3/Xwayland drag source. Shell's own drag
actors cannot export file data to application windows; Mutter bridges the
helper's native XDND offer to Wayland and X11 apps. The helper handles fractional-scale and stale-proxy cases in Mutter without a
compositor patch. It does not replace the clipboard or replay mouse presses. It is stopped when the extension is
disabled. Manual installations need the packaged `native-drag-helper` wrapper
for cross-app file drops; existing Shell drags remain available without it.

`tests/nativeDrag.js` exercises real mouse gestures and a separate GTK receiver
at normal and fractional display scales, repeated transfers, URI escaping,
Escape, early release, rejected drops and extension disable with a stopped
helper. A Shell heartbeat checks that feedback and input stay under 400 ms. Run it in an isolated GNOME
session with a temporary HOME, using `tests/nativeDropTarget.py` as the receiver.

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

## Add apps and nested stacks

Drag over the middle of a stack to see its outlined drop target, then release
to add the item. Directory stacks receive a
copy of its launcher; app folders keep native GNOME membership. A successful
addition removes an existing dock favorite. Drop near a stack's edge to reorder.

Directory stacks track installed `.desktop` IDs in their contents. Adding a
launcher hides that app from the app grid; removing the last copy restores its
original grid grouping. The installed launcher is never moved or changed.

Drop a stack onto another stack to nest it in the same popup. Directory-to-directory
drops add a uniquely named symlink and remove the source dock pin, preserving the
original folder. Virtual app folders remain references in `children`. Drag a
nested stack back to the dock to promote it, or to the grid to unpin it. Removing
an owned folder shortcut never deletes its original directory.

`tests/contents.js` exercises real pointer drops, launcher add/remove/rename,
duplicate copies, original native folder grouping, shortcut collisions,
navigation and cycle rejection in the isolated GNOME VM.
