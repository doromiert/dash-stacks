import {stackPath,stackKey} from './stackContents.js';
import Shell from 'gi://Shell';
import { AppFolderPins } from "./appFolders.js";
import { ScrollableDash } from "./scrollableDash.js";
import * as IconGrid from "resource:///org/gnome/shell/ui/iconGrid.js";
import * as Dash from "resource:///org/gnome/shell/ui/dash.js";
import * as DND from "resource:///org/gnome/shell/ui/dnd.js";
import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Pango from "gi://Pango";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

let CONFIG = {
  popupWidth: 400,
  popupHeight: 300,
  iconSize: 48,
  tooltipDelay: 500, // ms
};

function receiveContents(target, source, config, pins) {
  if(target._pendingDrop||!pins.canAdd(source,config))return false;
  target._pendingDrop=true;target.add_style_pseudo_class('active');
  const label=target._dashItem;
  if(label){label.setLabelText(`Adding to ${config.name}…`);label.showLabel();}
  pins.add(source,config).catch(error=>Main.notifyError('Could not add to stack',error.message)).finally(()=>{
    if(target._destroyed)return;
    target._pendingDrop=false;target.remove_style_pseudo_class('active');
    if(label){label.setLabelText(config.name);label.hideLabel();}
  });
  return true;
}

const CalloutArrow = GObject.registerClass(
  class CalloutArrow extends St.DrawingArea {
    _init() {
      super._init({
        width: 24,
        height: 12,
      });
    }
    vfunc_repaint() {
      let cr = this.get_context();
      cr.moveTo(0, 0);
      cr.lineTo(24, 0);
      cr.lineTo(12, 12);
      cr.closePath();
      cr.setSourceRGBA(54 / 255, 54 / 255, 58 / 255, 1);
      cr.fill();
    }
  },
);

const StackItem = GObject.registerClass(
  class StackItem extends St.Button {
    _init(fileInfo, dirPath, popupRef, shellApp = null, nestedStack = null) {
      super._init({
        style_class: "stack-item",
        reactive: true,
        track_hover: true,
        width: 84,
        height: 84,
        x_expand: false,
        y_expand: false,
      });

      const fileName = fileInfo.get_name();
      this.path = dirPath + "/" + fileName;
      this._pins=popupRef.sourceActor._pins;this._stackConfig=nestedStack;
      if(nestedStack){this.config=nestedStack;this._dashStack=true;}
      this.connect('destroy',()=>{this._destroyed=true;});
      let isDir = fileInfo.get_file_type() === Gio.FileType.DIRECTORY;
      this._folderPath = isDir ? this.path : null;
      let isApp = !nestedStack && fileName.endsWith(".desktop");
      shellApp??=isApp?Shell.AppSystem.get_default().lookup_app(fileName):null;
      this._stackApp=shellApp;

      let isDownloading = false;

      if (isDir) {
        try {
          let dir = Gio.File.new_for_path(this.path);
          let enumerator = dir.enumerate_children(
            "standard::name",
            Gio.FileQueryInfoFlags.NONE,
            null,
          );
          let info;
          while ((info = enumerator.next_file(null)) !== null) {
            let n = info.get_name();
            if (
              n.endsWith(".part") ||
              n.endsWith(".crdownload") ||
              n.includes(".goutputstream")
            ) {
              isDownloading = true;
              break;
            }
          }
          enumerator.close(null);
        } catch (e) {}
      } else {
        isDownloading =
          fileName.endsWith(".part") ||
          fileName.endsWith(".crdownload") ||
          fileName.includes(".goutputstream");
      }

      let displayName = fileName
        .replace(".desktop", "")
        .replace(".crdownload", "")
        .replace(".part", "")
        .replace(".goutputstream", "");

      let displayIcon = fileInfo.get_icon();

      if(nestedStack){displayName=nestedStack.name;displayIcon=Gio.ThemedIcon.new(nestedStack.icon??'folder');}
      // grab the real app name and icon if it's a desktop file
      if (isApp) {
        let appInfo = shellApp?.get_app_info() ?? Gio.DesktopAppInfo.new_from_filename(this.path);
        if (appInfo) {
          displayName = appInfo.get_name() || displayName;
          displayIcon = appInfo.get_icon() || displayIcon;
        }
      }

      let box = new St.BoxLayout({
        vertical: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      let iconBin = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        width: CONFIG.iconSize,
        height: CONFIG.iconSize,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      let icon = new St.Icon({
        gicon: displayIcon, // use the injected icon here
        icon_size: CONFIG.iconSize,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      iconBin.add_child(icon);

      if (isDownloading) {
        let overlay = new St.Bin({
          style_class: "stack-overlay",
          x_expand: true,
          y_expand: true,
          x_align: Clutter.ActorAlign.FILL,
          y_align: Clutter.ActorAlign.FILL,
        });

        let dlIcon = new St.Icon({
          icon_name: "folder-download-symbolic",
          icon_size: 24,
          x_expand: true,
          y_expand: true,
          x_align: Clutter.ActorAlign.CENTER,
          y_align: Clutter.ActorAlign.CENTER,
        });

        overlay.set_child(dlIcon);
        iconBin.add_child(overlay);
      }

      let label = new St.Label({
        text: displayName, // use the injected name here
        style_class: "stack-item-label",
        style: "max-width: 68px;",
      });

      label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      label.clutter_text.line_wrap = false;

      box.add_child(iconBin);
      box.add_child(label);
      this.set_child(box);

      this.connect("clicked", () => {
        if(nestedStack){popupRef._navigateStack(nestedStack);}
        else if (isDir) {
          popupRef._navigate(this.path, fileName);
        } else if (isApp) {
          if (shellApp) shellApp.activate();
          else {
            let app = Gio.DesktopAppInfo.new_from_filename(this.path);
            if (app) app.launch([], null);
          }
          Main.overview.hide();
          popupRef.sourceActor._closePopup();
        } else {
          Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(this.path).get_uri(), null);
          Main.overview.hide();
          popupRef.sourceActor._closePopup();
        }
      });

      this._delegate = this;
      let draggable = DND.makeDraggable(this, {
        restoreOnSuccess: false,
        manualMode: false,
      });

      draggable.connect("drag-begin", () => {
        Main.overview.beginItemDrag(this);
      });
      draggable.connect("drag-end", () => Main.overview.endItemDrag(this));
    }
    handleDragOver(source) {
      return this._stackConfig&&source!==this&&this._pins.canAdd(source,this._stackConfig)?DND.DragMotionResult.MOVE_DROP:DND.DragMotionResult.CONTINUE;
    }
    acceptDrop(source) {return !!this._stackConfig&&receiveContents(this,source,this._stackConfig,this._pins);}
  },
);

const StackPopup = GObject.registerClass(
  class StackPopup extends St.BoxLayout {
    _init(stackConfig, sourceActor) {
      super._init({
        style_class: "stack-popup-wrapper",
        vertical: true,
        reactive: true,
        width: CONFIG.popupWidth,
      });

      this.sourceActor = sourceActor;
      this.connect("destroy", () => {
        this._cancelLoad();
      });
      this.history = [{ ...stackConfig, path: stackPath(stackConfig) }];
      this._generation=0;
      this.set_pivot_point(0.5, 1.0);

      let contentBox = new St.BoxLayout({
        style_class: "stack-popup-content",
        vertical: true,
        height: CONFIG.popupHeight,
      });

      this.header = new St.BoxLayout({
        style_class: "stack-header",
        vertical: false,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });

      this.backBtn = new St.Button({
        child: new St.Icon({
          icon_name: "go-previous-symbolic",
          icon_size: 16,
        }),
        style_class: "stack-back-button",
        reactive: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
      });
      this.backBtn.connect("clicked", () => this._goBack());

      this.titleLabel = new St.Label({
        text: stackConfig.name,
        style_class: "stack-header-title",
        x_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      this.nautilusBtn = new St.Button({
        child: new St.Icon({
          icon_name: "folder-open-symbolic",
          icon_size: 16,
        }),
        style_class: "stack-nautilus-button",
        reactive: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      this.nautilusBtn.connect("clicked", () => {
        let current = this.history[this.history.length - 1];
        Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(current.path).get_uri(), null);

        this.sourceActor._closePopup();
        Main.overview.hide();
      });

      this.header.add_child(this.backBtn);
      this.header.add_child(this.titleLabel);
      this.header.add_child(this.nautilusBtn);
      this.nautilusBtn.visible = !sourceActor._appFolder;
      contentBox.add_child(this.header);

      this.scroll = new St.ScrollView({
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        enable_mouse_scrolling: true,
        overlay_scrollbars: true,
        x_expand: true,
        y_expand: true,
      });

      let touchStartY = null;
      let lastTouchY = null;
      let lastTouchTime = null;
      let velocity = 0;
      let isDragging = false;

      this.scroll.connect("captured-event", (actor, event) => {
        let type = event.type();

        if (type === Clutter.EventType.TOUCH_BEGIN) {
          this.scroll.vadjustment.remove_transition("value");

          let [x, y] = event.get_coords();
          touchStartY = y;
          lastTouchY = y;
          lastTouchTime = Date.now();
          velocity = 0;
          isDragging = false;
          return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.TOUCH_UPDATE) {
          if (touchStartY === null) return Clutter.EVENT_PROPAGATE;

          let [x, y] = event.get_coords();
          let dy = lastTouchY - y;
          let now = Date.now();
          let timeSinceLastFrame = now - lastTouchTime;

          if (!isDragging && Math.abs(touchStartY - y) > 10) {
            isDragging = true;
          }

          if (isDragging) {
            if (timeSinceLastFrame > 0) velocity = dy / timeSinceLastFrame;

            this.scroll.vadjustment.value += dy;
            lastTouchY = y;
            lastTouchTime = now;
            return Clutter.EVENT_STOP;
          }
        }

        if (
          type === Clutter.EventType.TOUCH_END ||
          type === Clutter.EventType.TOUCH_CANCEL
        ) {
          touchStartY = null;

          if (isDragging) {
            isDragging = false;

            if (Math.abs(velocity) > 0.5) {
              let amplitude = velocity * 400; // How far it glides
              let targetValue = this.scroll.vadjustment.value + amplitude;

              let lower = this.scroll.vadjustment.lower;
              let upper =
                this.scroll.vadjustment.upper -
                this.scroll.vadjustment.page_size;
              targetValue = Math.max(lower, Math.min(targetValue, upper));

              this.scroll.vadjustment.ease(targetValue, {
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                duration: 800, // ms
              });
            }
            return Clutter.EVENT_STOP;
          }
        }

        return Clutter.EVENT_PROPAGATE;
      });

      this.grid = new St.BoxLayout({
        vertical: true,
        style: "spacing: 12px;",
        x_expand: true,
        y_expand: true,
      });
      this.scroll.add_child(this.grid);
      contentBox.add_child(this.scroll);

      let arrowContainer = new St.Widget({
        width: CONFIG.popupWidth,
        height: 12,
      });
      let arrow = new CalloutArrow();
      arrow.set_position(CONFIG.popupWidth / 2 - 12, 0);
      arrowContainer.add_child(arrow);

      this.add_child(contentBox);
      this.add_child(arrowContainer);

      this._updateView();
    }

    _navigate(path, name) {this._navigateStack({path,name});}
    _navigateStack(stack) {this.history.push({...stack,path:stackPath(stack)});this._updateView();}
    _cancelLoad() {
      this._generation=(this._generation??0)+1;this._loadCancel?.cancel();
      if(this._loadIdleId)GLib.source_remove(this._loadIdleId);
      this._loadIdleId=0;this._yieldResolve?.();this._yieldResolve=null;
    }
    _yieldUI() {return new Promise(resolve=>{
      this._yieldResolve=resolve;
      this._loadIdleId=GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE,()=>{this._loadIdleId=0;this._yieldResolve=null;resolve();return GLib.SOURCE_REMOVE;});
    });}

    _goBack() {
      if (this.history.length > 1) {
        this.history.pop();
        this._updateView();
      }
    }

    _updateView() {
      this._cancelLoad();const current=this.history.at(-1);this.titleLabel.text=current.name;
      const isRoot=this.history.length===1;this.backBtn.opacity=isRoot?0:255;this.backBtn.reactive=!isRoot;
      this.nautilusBtn.visible=!!current.path;this.grid.destroy_all_children();this._renderCount=0;
      this._loadCancel=new Gio.Cancellable();
      this._loadView(current,this._generation,this._loadCancel).catch(error=>{
        if(!error.matches?.(Gio.IOErrorEnum,Gio.IOErrorEnum.CANCELLED))console.error(`[dash-stacks] ${error}`);
      });
    }
    async _loadView(current,generation,cancel) {
      const valid=()=>this._generation===generation&&!cancel.is_cancelled();
      const invoke=(object,method,finish,...args)=>new Promise((resolve,reject)=>object[method](...args,(f,r)=>{try{resolve(f[finish](r));}catch(e){reject(e);}}));
      const virtual=(current.children??[]).filter(child=>current.appFolder||child.appFolder);
      this._renderItems(virtual.map(child=>{
        const info=new Gio.FileInfo();info.set_name(child.name);info.set_file_type(Gio.FileType.DIRECTORY);info.set_icon(Gio.ThemedIcon.new(child.icon??'folder'));
        return new StackItem(info,current.path??GLib.get_home_dir(),this,null,child);
      }));
      if(current.appFolder){
        const apps=this.sourceActor._pins.getFolder(current.appFolder)?.apps??[];
        for(let i=0;i<apps.length&&valid();i+=24){
          this._renderItems(apps.slice(i,i+24).map(app=>{
            const appInfo=app.get_app_info(),filename=appInfo.get_filename(),info=new Gio.FileInfo();
            info.set_name(GLib.path_get_basename(filename));info.set_file_type(Gio.FileType.REGULAR);info.set_icon(appInfo.get_icon()??Gio.ThemedIcon.new('application-x-executable'));
            return new StackItem(info,GLib.path_get_dirname(filename),this,app);
          }));
          if(i+24<apps.length)await this._yieldUI();
        }
        return;
      }
      this.titleLabel.text=`${current.name} · Loading…`;let enumerator;
      try {
        enumerator=await invoke(Gio.File.new_for_path(current.path),'enumerate_children_async','enumerate_children_finish','standard::name,standard::icon,standard::type',Gio.FileQueryInfoFlags.NONE,GLib.PRIORITY_DEFAULT,cancel);
        while(valid()){
          const batch=await invoke(enumerator,'next_files_async','next_files_finish',32,GLib.PRIORITY_DEFAULT,cancel);
          if(!valid()||!batch.length)break;
          this._renderItems(batch.filter(info=>!info.get_name().startsWith('.')).map(info=>{
            const path=current.path+'/'+info.get_name(),nested=(current.children??[]).find(child=>stackPath(child)===path);
            return new StackItem(info,current.path,this,null,nested);
          }));
          await this._yieldUI();
        }
      }finally{
        if(valid())this.titleLabel.text=current.name;
        if(enumerator)try{await invoke(enumerator,'close_async','close_finish',GLib.PRIORITY_DEFAULT,null);}catch{}
      }
    }
    _renderItems(items) {
      items.forEach((item, index) => {
        if (this._renderCount % 4 === 0) this.grid.add_child(new St.BoxLayout({style: "spacing: 12px;"}));
        this.grid.get_last_child().add_child(item);this._renderCount++;
      });
    }

  },
);

const StackButton = GObject.registerClass(
  class StackButton extends St.Button {
    _init(stackConfig, settings, index, pins) {
      super._init({
        style_class: "overview-tile dash-stack-button",
        reactive: true,
        track_hover: true,
        can_focus: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      this.config = stackConfig;
      this._pins = pins;
      this._appFolder = stackConfig.appFolder ? (pins.getFolder(stackConfig.appFolder)??{name:stackConfig.name,apps:[]}) : null;
      this._dashStack = true;
      this._delegate = this;
      this.connect("destroy", () => this._onDestroy());
      this._settings = settings;
      this._index = index;
      this._tooltipTimeoutId = 0;

      let resolvedPath = this.config.path?.startsWith("~/")
        ? GLib.get_home_dir() + this.config.path.substring(1)
        : (this.config.path ?? "");

      this._resolvedPath = resolvedPath;
      this.icon = new IconGrid.BaseIcon(stackConfig.name, {
        createIcon: this._createIcon.bind(this), setSizeManually: true, showLabel: false,
      });
      this.icon.setIconSize(64);
      this.set_child(this.icon);

      if (!this._appFolder) {
      this._dirMonitor = Gio.File.new_for_path(resolvedPath).monitor_directory(
        Gio.FileMonitorFlags.NONE,
        null,
      );
      this._dirMonitor.connect("changed", () =>
        this._checkDownloads(resolvedPath),
      );
      this._checkDownloads(resolvedPath);

      }
      this._menuManager = new PopupMenu.PopupMenuManager(this);
      this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
      this._menu.actor.add_style_class_name("dash-stacks-context-menu");
      this._menuManager.addMenu(this._menu);
      Main.uiGroup.add_child(this._menu.actor);
      this._menu.actor.hide();

      this._buildMenu();

      this._draggable = DND.makeDraggable(this, {timeoutThreshold: 200});
      this._draggable.connect("drag-begin", () => {
        this._dragging = true;
        this._closePopup();
        Main.overview.beginItemDrag(this);
      });
      this._draggable.connect("drag-end", () => {
        this._dragging = false;
        Main.overview.endItemDrag(this);
      });
      this.connect("clicked", () => { if (!this._dragging) this._togglePopup(); });
      const openMenu = () => {
        this._dashItem?.hideLabel();
        this._menu.toggle();
      };
      this.connect("popup-menu", openMenu);
      const rightClick = new Clutter.ClickGesture({required_button: Clutter.BUTTON_SECONDARY, recognize_on_press: true});
      rightClick.connect("recognize", openMenu);
      this.add_action(rightClick);
      const longPress = new Clutter.LongPressGesture();
      longPress.connect("recognize", openMenu);
      this.add_action(longPress);

    }

    _createIcon(size) {
      let iconBin = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        width: size * St.ThemeContext.get_for_stage(global.stage).scale_factor,
        height: size * St.ThemeContext.get_for_stage(global.stage).scale_factor,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      if (this.config.autoIcon) {
        this.mainIcon = this._createAutoIconWidget(this._resolvedPath, size);
      } else {
        this.mainIcon = new St.Icon({
          icon_name: this.config.icon,
          icon_size: size,
          x_expand: true,
          y_expand: true,
          x_align: Clutter.ActorAlign.CENTER,
          y_align: Clutter.ActorAlign.CENTER,
        });
      }

      this.downloadOverlay = new St.Bin({
        style_class: "stack-overlay",
        x_expand: false,
        y_expand: false,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
        opacity: 0,
      });
      this.downloadOverlay.set_pivot_point(0.5, 0.5);

      this.dlIcon = new St.Icon({
        icon_name: "folder-download-symbolic",
        icon_size: Math.min(32, size),
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      this.downloadOverlay.set_child(this.dlIcon);
      iconBin.add_child(this.mainIcon);
      iconBin.add_child(this.downloadOverlay);
      return iconBin;

    }

    get id() { return this.config.appFolder ?? `dash-stack:${this.config.path}`; }
    getDragActor() { return new Clutter.Clone({source: this.mainIcon}); }
    getDragActorSource() { return this.mainIcon; }
    handleDragOver(source,_actor,x=this.width/2) {
      if(source===this||this._pendingDrop)return DND.DragMotionResult.CONTINUE;
      const center=x>=this.width/4&&x<=this.width*3/4;
      if(center&&this._pins.canAdd(source,this.config))return DND.DragMotionResult.MOVE_DROP;
      return this._pins.accepts(source)?DND.DragMotionResult.MOVE_DROP:DND.DragMotionResult.CONTINUE;
    }
    acceptDrop(source,_actor,x=this.width/2) {
      if(source===this)return false;
      if(x>=this.width/4&&x<=this.width*3/4&&this._pins.canAdd(source,this.config))return receiveContents(this,source,this.config,this._pins);
      return this._pins.drop(source,this._index+(x>this.width/2?1:0));
    }
    _refreshContents() {
      this._appFolder=this.config.appFolder?(this._pins.getFolder(this.config.appFolder)??{name:this.config.name,apps:[]}):null;
      if(this.config.autoIcon)this.icon.update();this.popup?._updateView();
    }

    _getGridIcons(fullPath) {
      if (this._appFolder) return [...this._appFolder.apps.slice(0,4).map(app=>app.get_app_info().get_icon()??Gio.ThemedIcon.new('application-x-executable')),
        ...(this.config.children??[]).map(child=>Gio.ThemedIcon.new(child.icon??'folder'))].slice(0,4);
      let icons = [];
      try {
        let dir = Gio.File.new_for_path(fullPath);
        let iter = dir.enumerate_children(
          "standard::name,standard::type,standard::icon,standard::is-hidden",
          Gio.FileQueryInfoFlags.NONE,
          null,
        );

        let files = [];
        let folders = [];
        let info;

        while ((info = iter.next_file(null)) !== null) {
          if (info.get_is_hidden()) continue;

          let type = info.get_file_type();
          let icon = info.get_icon();

          if (type === Gio.FileType.REGULAR) {
            let fileName = info.get_name();
            if (fileName.endsWith(".desktop")) {
              let appInfo = Gio.DesktopAppInfo.new_from_filename(
                `${fullPath}/${fileName}`,
              );
              if (appInfo && appInfo.get_icon()) {
                icon = appInfo.get_icon();
              }
            }
            files.push(icon);
          } else if (type === Gio.FileType.DIRECTORY) {
            folders.push(icon);
          }

          if (files.length >= 4) break;
        }

        icons = [...files, ...folders, ...(this.config.children??[]).filter(child=>child.appFolder).map(child=>Gio.ThemedIcon.new(child.icon??'folder'))].slice(0, 4);
      } catch (e) {
        console.warn(`[dash-stacks] auto-icon scan failed: ${e}`);
      }
      return icons;
    }

    _createAutoIconWidget(fullPath, size = 64) {
      let grid = new St.BoxLayout({
        vertical: true,
        style_class: "stack-auto-icon",
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      let icons = this._getGridIcons(fullPath);
      const iconSize = Math.max(1, Math.min(26, Math.floor((size - 10) / 2)));
      const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

      for (let r = 0; r < 2; r++) {
        let row = new St.BoxLayout({ style_class: "stack-auto-row" });
        for (let c = 0; c < 2; c++) {
          let i = r * 2 + c;
          if (i < icons.length && icons[i]) {
            row.add_child(
              new St.Icon({
                gicon: icons[i],
                icon_size: iconSize,
              }),
            );
          } else {
            row.add_child(
              new St.Widget({
                width: iconSize * scale,
                height: iconSize * scale,
              }),
            );
          }
        }
        grid.add_child(row);
      }
      return grid;
    }

    _checkDownloads(path) {
      if (this._scanTimeoutId) return;

      this._scanTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        try {
          let dir = Gio.File.new_for_path(path);
          let enumerator = dir.enumerate_children(
            "standard::name",
            Gio.FileQueryInfoFlags.NONE,
            null,
          );
          let isDownloading = false;

          let fileInfo;
          while ((fileInfo = enumerator.next_file(null)) !== null) {
            let name = fileInfo.get_name();
            if (
              name.endsWith(".part") ||
              name.endsWith(".crdownload") ||
              name.includes(".goutputstream")
            ) {
              isDownloading = true;
              break;
            }
          }
          enumerator.close(null);

          if (isDownloading && this.downloadOverlay.opacity === 0) {
            this.downloadOverlay.set_scale(1.5, 1.5);
            this.downloadOverlay.ease({
              opacity: 255,
              scale_x: 1.0,
              scale_y: 1.0,
              duration: 200,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this.mainIcon.ease({
              opacity: 100,
              duration: 200,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this._triggerJumpIndicator(true);
          } else if (!isDownloading && this.downloadOverlay.opacity === 255) {
            this.downloadOverlay.ease({
              opacity: 0,
              scale_x: 1.5,
              scale_y: 1.5,
              duration: 200,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this.mainIcon.ease({
              opacity: 255,
              duration: 200,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this._triggerJumpIndicator(false);
          }
        } catch (e) {}

        this._scanTimeoutId = null;
        return GLib.SOURCE_REMOVE;
      });
    }

    _triggerJumpIndicator(isStarting) {
      if (Main.overview.visible) return;

      let [startX, startY] = this.get_transformed_position();
      let [width, height] = this.get_transformed_size();

      let w = width > 0 ? width : 64;
      let h = height > 0 ? height : 64;

      let clone = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        width: w,
        height: h,
      });

      let mainClone;
      if (this.config.autoIcon) {
        let resolvedPath = this.config.path.startsWith("~/")
          ? GLib.get_home_dir() + this.config.path.substring(1)
          : this.config.path;
        mainClone = this._createAutoIconWidget(resolvedPath, this.icon.iconSize);
      } else {
        mainClone = new St.Icon({
          icon_name: this.config.icon,
          icon_size: this.icon.iconSize,
          x_align: Clutter.ActorAlign.CENTER,
          y_align: Clutter.ActorAlign.CENTER,
        });
      }

      mainClone.opacity = isStarting ? 100 : 255;
      clone.add_child(mainClone);

      if (isStarting) {
        let dlClone = new St.Icon({
          icon_name: "folder-download-symbolic",
          icon_size: 32,
          x_align: Clutter.ActorAlign.CENTER,
          y_align: Clutter.ActorAlign.CENTER,
        });
        let overlayClone = new St.Bin({
          style_class: "stack-overlay",
          child: dlClone,
          x_align: Clutter.ActorAlign.FILL,
          y_align: Clutter.ActorAlign.FILL,
        });
        clone.add_child(overlayClone);
      }

      Main.uiGroup.add_child(clone);
      clone.set_position(startX, startY);

      clone.ease({
        y: startY - 75,
        duration: 300,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          clone.ease({
            y: startY,
            opacity: 0,
            duration: 400,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => clone.destroy(),
          });
        },
      });
    }

    _createHeader(title) {
      let item = new PopupMenu.PopupBaseMenuItem({
        style_class: "menu-header-item",
        reactive: false,
        can_focus: false,
      });

      let headerBox = new St.BoxLayout({
        style_class: "menu-header",
        x_expand: true,
      });

      let label = new St.Label({
        text: title,
        style_class: "header-text",
      });

      let line = new St.Widget({
        style_class: "header-line",
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });

      headerBox.add_child(label);
      headerBox.add_child(line);

      item.add_child(headerBox);
      return item;
    }

    _buildMenu() {
      this._menu.removeAll();

      this._menu.addMenuItem(this._createHeader("Rename"));

      let nameItem = new PopupMenu.PopupBaseMenuItem({
        reactive: true,
        can_focus: true,
        style_class: "menu-input-row",
      });

      let nameEntry = new St.Entry({
        text: this.config.name,
        style_class: "menu-entry",
        x_expand: true,
      });
      nameEntry.set_x_align(Clutter.ActorAlign.FILL);

      nameItem.connect("button-press-event", () => {
        nameEntry.grab_key_focus();
        return Clutter.EVENT_STOP;
      });

      nameEntry.clutter_text.connect("activate", () => {
        this._updateConfig("name", nameEntry.get_text());
        this._menu.close();
      });

      nameItem.add_child(nameEntry);
      this._menu.addMenuItem(nameItem);

      this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      // right-click toggle for auto icon
      let autoIconToggle = new PopupMenu.PopupSwitchMenuItem(
        "Show Folder Contents",
        !!this.config.autoIcon,
      );
      autoIconToggle.connect("toggled", (item, state) => {
        this._updateConfig("autoIcon", state);
        // changing settings should trigger your main class to rebuild the buttons automatically
      });
      this._menu.addMenuItem(autoIconToggle);

      this._menu.addMenuItem(this._createHeader("Change Icon"));

      let iconItem = new PopupMenu.PopupBaseMenuItem({
        reactive: true,
        can_focus: true,
        style_class: "menu-input-row",
      });

      let iconEntry = new St.Entry({
        text: this.config.icon,
        style_class: "menu-entry",
        x_expand: true,
      });
      iconEntry.set_x_align(Clutter.ActorAlign.FILL);

      iconItem.connect("button-press-event", () => {
        iconEntry.grab_key_focus();
        return Clutter.EVENT_STOP;
      });

      iconEntry.clutter_text.connect("activate", () => {
        this._updateConfig("icon", iconEntry.get_text());
        this._menu.close();
      });

      iconItem.add_child(iconEntry);
      this._menu.addMenuItem(iconItem);

      this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      let deleteItem = new PopupMenu.PopupMenuItem("Unpin from Dock");
      deleteItem.add_style_class_name("destruct-button");
      deleteItem.connect("activate", () => this._deleteSelf());
      this._menu.addMenuItem(deleteItem);
    }

    _updateConfig(key, value) {
      let stacks = JSON.parse(this._settings.get_string("stacks"));
      if (stacks[this._index]) {
        stacks[this._index][key] = value;
        this._settings.set_string("stacks", JSON.stringify(stacks));
      }
    }

    _deleteSelf() {
      let stacks = JSON.parse(this._settings.get_string("stacks"));
      if (this.config.appFolder) {
        this._pins._setPinned(this.config.appFolder, false);
        return;
      }
      stacks.splice(this._index, 1);
      this._settings.set_string("stacks", JSON.stringify(stacks));
    }

    _togglePopup() {
      if (this.popup) {
        this._closePopup();
        return;
      }

      this.popup = new StackPopup(this.config, this);
      this.popup.opacity = 0;
      this.popup.scale_x = 0.8;
      this.popup.scale_y = 0.8;

      Main.layoutManager.uiGroup.add_child(this.popup);

      let [x, y] = this.get_transformed_position();
      this.popup.set_position(
        Math.max(0, x - CONFIG.popupWidth / 2 + this.get_width() / 2),
        y - CONFIG.popupHeight - 16,
      );

      this.popup.ease({
        opacity: 255,
        scale_x: 1.0,
        scale_y: 1.0,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });

      this._capturedEventId = global.stage.connect(
        "captured-event",
        (actor, event) => {
          let type = event.type();
          if (
            type === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape
          ) {
            this._closePopup();
            return Clutter.EVENT_STOP;
          }

          if (
            type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN
          ) {
            let [clickX, clickY] = event.get_coords();
            let [pX, pY] = this.popup.get_transformed_position();
            let [pW, pH] = this.popup.get_transformed_size();
            let insidePopup =
              clickX >= pX &&
              clickX <= pX + pW &&
              clickY >= pY &&
              clickY <= pY + pH;
            let [bX, bY] = this.get_transformed_position();
            let [bW, bH] = this.get_transformed_size();
            let insideButton =
              clickX >= bX &&
              clickX <= bX + bW &&
              clickY >= bY &&
              clickY <= bY + bH;

            if (!insidePopup && !insideButton) this._closePopup();
          }
          return Clutter.EVENT_PROPAGATE;
        },
      );
    }

    _closePopup() {
      if (!this.popup || this._isClosing) return;
      this._isClosing = true;

      if (this._capturedEventId) {
        global.stage.disconnect(this._capturedEventId);
        this._capturedEventId = 0;
      }

      this.popup.ease({
        opacity: 0,
        scale_x: 0.8,
        scale_y: 0.8,
        duration: 150,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onComplete: () => {
          this.popup.destroy();
          this.popup = null;
          this._isClosing = false;
        },
      });
    }

    _onDestroy() {
      this._destroyed=true;
      if (this._capturedEventId) global.stage.disconnect(this._capturedEventId);
      if (this.popup) {
        this.popup.remove_all_transitions();
        this.popup.destroy();
        this.popup = null;
      }
      if (this._longPressId) GLib.source_remove(this._longPressId);
      if (this._scanTimeoutId) {
        GLib.source_remove(this._scanTimeoutId);
        this._scanTimeoutId = null;
      }
      if (this._dirMonitor) {
        this._dirMonitor.cancel();
        this._dirMonitor = null;
      }
      if (this._tooltipTimeoutId > 0)
        GLib.source_remove(this._tooltipTimeoutId);
      if (this._menu) this._pins._destroyMenu(this._menu);
    }
  },
);

export default class DashStacksExtension extends Extension {
  enable() {
    if (this._settings) return;
    this._settings = this.getSettings();

    const syncConfig = () => {
      CONFIG.popupWidth = this._settings.get_int("popup-width");
      CONFIG.popupHeight = this._settings.get_int("popup-height");
      CONFIG.iconSize = this._settings.get_int("icon-size");
      CONFIG.tooltipDelay = this._settings.get_int("tooltip-delay");
    };

    syncConfig();


    this._buttons = [];
    this._stacksSignature = null;
    this._configSignals = [];
    this._appFolderPins = new AppFolderPins(this._settings, () => {
      this._injectStacks();this._buttons.forEach(item=>item._stackButton?._refreshContents());this._dock?.queueLayout();
    });
    ["popup-width", "popup-height", "icon-size", "tooltip-delay"].forEach(
      (key) => {
        let sig = this._settings.connect(`changed::${key}`, () => {
          syncConfig();
          this._injectStacks();
        });
        this._configSignals.push(sig);
      },
    );

    let dash = Main.overview.dash;
    this._themeContext = St.ThemeContext.get_for_stage(global.stage);
    this._scaleSignal = this._themeContext.connect("notify::scale-factor", () => {
      this._injectStacks();
      this._dock?.queueLayout();
    });
    this._originalRedisplay = dash._redisplay;
    this._overviewHidingId = Main.overview.connect("hiding", () => {
      this._buttons.forEach((btn) => {
        if (btn._stackButton?.popup) btn._stackButton._closePopup();
      });
    });

    dash._redisplay = () => {
      this._originalRedisplay.call(dash);
      this._injectStacks();
    };

    this._injectStacks();

    this._layoutIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._layoutIdleId = null;
      this._dock = new ScrollableDash(Main.overview.dash);

      return GLib.SOURCE_REMOVE;
    });
  }

  _injectStacks() {
    if (this._injecting || !this._settings) return;
    this._injecting = true;
    try {
      const stacks = this._getStacksConfig();
      const signature = JSON.stringify([stacks, CONFIG, St.ThemeContext.get_for_stage(global.stage).scale_factor, stacks.map(stack =>
        stack.appFolder ? this._appFolderPins.getFolder(stack.appFolder)?.apps.map(app => [app.get_id(), app.get_name()]) : null)]);
      if (signature === this._stacksSignature && this._buttons.every(button => button.get_parent() === Main.overview.dash._box)) return;
      this._stacksSignature = signature;
      this._clearButtons();
      this._buttons = [];

      if (stacks.length === 0) return;

      let separator = new St.Widget({
        style_class: "dash-stacks-separator",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._buttons.push(separator);
      Main.overview.dash._box.add_child(separator);

      const folderIds = new Set();
      stacks.forEach((stack, index) => {
        if (stack.appFolder && folderIds.has(stack.appFolder)) return;
        if (stack.appFolder) folderIds.add(stack.appFolder);
        if (stack.appFolder && !this._appFolderPins.getFolder(stack.appFolder) && !stack.children?.length) return;
        const btn = new StackButton(stack, this._settings, index, this._appFolderPins);
        const item = new Dash.DashItemContainer();
        item._stackButton = btn;
        btn._dashItem = item;
        item.setChild(btn);
        btn.x_expand = false;
        btn.y_expand = false;
        item.setLabelText(stack.name);
        Main.overview.dash._hookUpLabel(item);
        item.show(false);
        this._buttons.push(item);
        Main.overview.dash._box.add_child(item);
      });
    } finally {
      this._injecting = false;
    }
  }

  _clearButtons() {
    const dash = Main.overview.dash;
    for (const item of this._buttons) {
      if (item.child) {
        item.child.track_hover = false;
        item.child.set_hover(false);
      }
      item.label?.remove_all_transitions();
      item.destroy();
    }
    // Destroying a hovered item can queue one last native label callback.
    if (dash._showLabelTimeoutId) {
      GLib.source_remove(dash._showLabelTimeoutId);
      dash._showLabelTimeoutId = 0;
    }
  }

  _getStacksConfig() {
    try {
      const stacksJson = this._settings.get_string("stacks");
      const stacks = JSON.parse(stacksJson);
      const homeDir = GLib.get_home_dir();
      return stacks.map((stack) => {
        if (stack.path && stack.path.startsWith("~/"))
          stack.path = homeDir + stack.path.substring(1);
        return stack;
      });
    } catch (e) {
      return [];
    }
  }

  disable() {
    for (const key of ["_layoutIdleId"]) {
      if (this[key]) GLib.source_remove(this[key]);
      this[key] = null;
    }
    if (this._scaleSignal) this._themeContext.disconnect(this._scaleSignal);
    this._scaleSignal = 0;
    this._appFolderPins?.destroy();
    this._appFolderPins = null;
    if (this._configSignals && this._settings) {
      this._configSignals.forEach((sig) => this._settings.disconnect(sig));
      this._configSignals = [];
    }

    if (this._settingsSignal && this._settings) this._settings.disconnect(this._settingsSignal);
    this._settingsSignal = null;
    this._settings = null;

    if (this._originalRedisplay)
      Main.overview.dash._redisplay = this._originalRedisplay;

    if (this._overviewHidingId)
      Main.overview.disconnect(this._overviewHidingId);

    this._clearButtons();
    this._buttons = [];

    this._dock?.destroy();
    this._dock = null;
  }
}
