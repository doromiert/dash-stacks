# Dash Stacks

![-0 cert](https://cert.neg-zero.com/crW7769)

Ever wished GNOME let you pin folders to the dash?

Well guess what, this extension does just that... and makes it so that the dash is scrollable when it overflows (workaround for a bug i caused but honestly i like this more than the default behavior).


## Pin app-grid folders

Right-click an app folder in the app grid and choose **Pin to Dock**. The folder
then appears beside your directory stacks and leaves the app grid. Click it to
open the normal GNOME folder dialog. Right-click it and choose **Unpin from
Dock** to return it to the grid. Keyboard context menus and touch long-press
work too. Folder membership is never deleted or copied: renaming and editing
the original GNOME folder keeps the dock preview current. Search still finds
its apps. Disabling Dash Stacks restores all folders to the app grid.

Pins are stored per user as folder IDs in the `pinned-app-folders` setting.
Runtime acceptance is exercised by `tests/appFolders.js` in a real GNOME50
VM through ZenPkgs' `dash-stacks-vm` check.
