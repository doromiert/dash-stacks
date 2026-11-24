{ lib, stdenvNoCC, glib, gtk3, gobject-introspection, makeWrapper, wrapGAppsHook3, python3 }:
let python = python3.withPackages (ps: [ ps.pygobject3 ps.pycairo ps.xlib ]);
in stdenvNoCC.mkDerivation {
  pname = "dash-stacks";
  version = "0-unstable-2026-11-24";
  src = lib.cleanSource ./.;
  nativeBuildInputs = [ glib gobject-introspection makeWrapper wrapGAppsHook3 ];
  buildInputs = [ gtk3 ];
  dontWrapGApps = true;
  installPhase = ''
    runHook preInstall
    destination="$out/share/gnome-shell/extensions/dash-stacks@neg-zero.com"
    mkdir -p "$destination"
    cp -r . "$destination/"
    glib-compile-schemas "$destination/schemas"
    makeWrapper ${python}/bin/python3 "$destination/native-drag-helper" \
      --add-flags "$destination/nativeDrag.py"
    runHook postInstall
  '';
  preFixup = ''
    wrapProgram "$out/share/gnome-shell/extensions/dash-stacks@neg-zero.com/native-drag-helper" \
      "''${gappsWrapperArgs[@]}"
  '';
  passthru.extensionUuid = "dash-stacks@neg-zero.com";
  meta = {
    description = "macOS-style folder stacks for the GNOME dash";
    homepage = "https://github.com/doromiert/dash-stacks";
    license = {
      shortName = "napalm";
      fullName = "NAPALM: The Non-Aggression Principle Anti-License Mandate 2.0";
      url = "https://github.com/negative-zero-inft/nap-license";
      free = false;
      redistributable = true;
      copyleft = true;
    };
    platforms = lib.platforms.linux;
  };
}
