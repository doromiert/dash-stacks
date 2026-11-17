import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Keep GNOME's native items and labels; only replace its overflow policy.
export class ScrollableDash {
    constructor(dash) {
        this.dash = dash;
        this._originalAdjust = dash._adjustIconSize;
        this._parent = dash._box.get_parent();
        this._showAppsParent = dash._showAppsIcon.get_parent();
        this._showAppsIndex = this._showAppsParent.get_children().indexOf(dash._showAppsIcon);
        this._itemSizes = new Map();
        this._buttonSizes = new Map();
        this._slotSizes = new Map();
        this._originalLayout = dash._box.layout_manager;
        // The native DashIconsLayout deliberately reports min-width=0, allowing
        // shrinking. A normal box gives StViewport the full scrollable extent.
        dash._box.layout_manager = new Clutter.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            spacing: this._originalLayout.spacing,
        });
        this.row = new St.BoxLayout({x_expand: true, y_expand: true});
        this.scroll = new St.ScrollView({
            style_class: 'dash-scroll-view', reactive: true,
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true, x_expand: true, y_expand: true,
        });
        this.content = new St.BoxLayout({y_expand: true});
        this._parent.remove_child(dash._box);
        this.content.add_child(dash._box);
        this.scroll.set_child(this.content);
        this.row.add_child(this.scroll);
        this._showAppsParent.remove_child(dash._showAppsIcon);
        this.row.add_child(dash._showAppsIcon);
        this._parent.insert_child_at_index(this.row, 0);
        dash._adjustIconSize = () => this.queueLayout();
        this._addedId = dash._box.connect('child-added', () => this.queueLayout());
        this._removedId = dash._box.connect('child-removed', () => this.queueLayout());
        this._styleId = dash.connect('style-changed', () => this.queueLayout());
        this._theme = St.ThemeContext.get_for_stage(global.stage);
        this._scaleId = this._theme.connect('notify::scale-factor', () => this.queueLayout());
        this._focusId = global.stage.connect('notify::key-focus', () => this._revealFocus());
        this.scroll.connect('captured-event', (_actor, event) => this._scrollEvent(event));
        this._scrollId = this.scroll.hadjustment.connect('notify::value', () => this._hideLabels());
        // A native touch gesture cancels button clicks when scrolling wins, without
        // stealing the mouse gesture used to drag app and folder pins.
        if (Clutter.PanGesture) {
            this._pan = new Clutter.PanGesture({pan_axis: Clutter.PanAxis.X});
            this._pan.connect('may-recognize', () => {
                const type = this._pan.get_point_event(0)?.type();
                return type === Clutter.EventType.TOUCH_BEGIN || type === Clutter.EventType.TOUCH_UPDATE;
            });
            this._pan.connect('pan-update', () => {
                this.scroll.hadjustment.value -= this._pan.get_delta_abs().get_x() * this._direction;
            });
            this.scroll.add_action_full('dash-scroll-pan', Clutter.EventPhase.CAPTURE, this._pan);
        }
        this._dragMonitor = {dragMotion: event => this._dragMotion(event)};
        DND.addDragMonitor(this._dragMonitor);
        this._dragEndIds = ['item-drag-end', 'item-drag-cancelled', 'window-drag-end', 'window-drag-cancelled']
            .map(signal => Main.overview.connect(signal, () => this._stopDragScroll()));
        this.queueLayout();
    }

    _saveSize(actor) {
        return Object.fromEntries(['min_width', 'natural_width', 'min_height', 'natural_height',
            'min_width_set', 'natural_width_set', 'min_height_set', 'natural_height_set', 'x_align', 'y_align', 'x_expand', 'y_expand']
            .map(key => [key, actor[key]]));
    }

    _rememberSize(sizes, actor) {
        if (sizes.has(actor)) return;
        const size = this._saveSize(actor);
        size.destroyId = actor.connect('destroy', () => sizes.delete(actor));
        sizes.set(actor, size);
    }

    queueLayout() {
        if (this._layoutId) return;
        this._layoutId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._layoutId = 0;
            this._layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _layout() {
        const dash = this.dash;
        const scale = this._theme.scale_factor;
        const items = [...dash._box.get_children(), dash._showAppsIcon];
        // Preserve the largest native size that fits vertically; item count and
        // available width must never shrink icons. Tiny HiDPI displays still fit.
        const showButton = dash._showAppsIcon.child;
        const showIcon = showButton._delegate.icon;
        this._rememberSize(this._itemSizes, showIcon);
        showIcon.set_size(-1, -1);
        const oldTextureSize = showIcon.iconSize * scale;
        showIcon.icon.set_size(oldTextureSize, oldTextureSize);
        const padding = showButton.get_preferred_height(-1)[1] - oldTextureSize;
        const available = dash._maxHeight > 0 ? dash._maxHeight - padding : Infinity;
        const iconSize = [16, 22, 24, 32, 48, 64].filter(size => size * scale <= available).at(-1) ?? 16;
        if (dash.iconSize !== iconSize) {
            dash.iconSize = iconSize;
            dash.emit('icon-size-changed');
        }
        let slot = 0;
        for (const item of items) {
            const icon = item.child?._delegate?.icon;
            if (!icon) continue; // separators and DND placeholders retain native sizing
            this._rememberSize(this._itemSizes, icon);
            icon.icon?.remove_transition('width');
            icon.icon?.remove_transition('height');
            icon.setIconSize(iconSize);
            icon.icon?.set_size(iconSize * scale, iconSize * scale);
            icon.set_size(-1, -1);
            slot = Math.max(slot, ...icon.get_preferred_size());
        }
        for (const icon of this._itemSizes.keys()) {
            icon.set_size(slot, slot);
            icon.x_align = Clutter.ActorAlign.CENTER;
            icon.y_align = Clutter.ActorAlign.CENTER;
        }
        let buttonSlot = 0;
        const buttons = items.filter(item => item.child?._delegate?.icon).map(item => item.child);
        for (const button of buttons) {
            this._rememberSize(this._buttonSizes, button);
            buttonSlot = Math.max(buttonSlot, ...button.get_preferred_size());
        }
        // Make the native item slots square; retain native button edge padding
        // and margins inside them so running dots and hit targets stay correct.
        for (const item of items.filter(item => item.child?._delegate?.icon)) {
            this._rememberSize(this._slotSizes, item);
            item.set_size(buttonSlot, buttonSlot);
            item.x_expand = false;
            item.y_expand = false;
            item.y_align = Clutter.ActorAlign.CENTER;
            item.child.x_expand = true;
            item.child.y_expand = true;
            item.child.x_align = Clutter.ActorAlign.FILL;
            item.child.y_align = Clutter.ActorAlign.FILL;
        }
        for (const item of items) {
            if (item === dash._separator || item.has_style_class_name('dash-stacks-separator'))
                item.height = iconSize * scale;
        }
        const theme = dash.get_theme_node();
        const maxWidth = dash._maxWidth;
        if (maxWidth > 0) {
            const content = theme.get_content_box(new Clutter.ActorBox({
                x1: 0, y1: 0, x2: maxWidth, y2: dash._maxHeight,
            }));
            // CSS lengths are logical; _maxWidth and preferred widths are physical.
            const showWidth = dash._showAppsIcon.get_preferred_width(-1)[1];
            const width = Math.max(slot, content.get_width() - showWidth);
            const style = `max-width: ${width / scale}px;`;
            if (this.scroll.style !== style) this.scroll.style = style;
        }
        this._revealFocus();
    }

    get _direction() {
        return this.scroll.get_text_direction() === Clutter.TextDirection.RTL ? -1 : 1;
    }

    _scrollEvent(event) {
        if (event.type() !== Clutter.EventType.SCROLL) return Clutter.EVENT_PROPAGATE;
        const adj = this.scroll.hadjustment;
        if (adj.upper <= adj.page_size) return Clutter.EVENT_PROPAGATE;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const delta = Math.abs(dx) > Math.abs(dy) ? dx * this._direction : dy;
            adj.adjust_for_scroll_event(delta);
        } else {
            const backwards = direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT;
            const horizontal = direction === Clutter.ScrollDirection.LEFT || direction === Clutter.ScrollDirection.RIGHT;
            adj.value += (backwards ? -1 : 1) * (horizontal ? this._direction : 1) * 64 * this._theme.scale_factor;
        }
        return Clutter.EVENT_STOP;
    }

    _hideLabels() {
        if (this.dash._showLabelTimeoutId) {
            GLib.source_remove(this.dash._showLabelTimeoutId);
            this.dash._showLabelTimeoutId = 0;
        }
        this.dash._labelShowing = false;
        for (const item of [...this.dash._box.get_children(), this.dash._showAppsIcon]) {
            item.label?.remove_all_transitions();
            item.label?.hide();
        }
    }

    _revealFocus() {
        const focus = global.stage.key_focus;
        if (!focus || !this.dash._box.contains(focus) || !focus.has_allocation()) return;
        const [x] = focus.get_transformed_position();
        const [left] = this.scroll.get_transformed_position();
        const [width] = focus.get_transformed_size();
        const adj = this.scroll.hadjustment;
        const fade = this.scroll.get_effect('fade')?.fade_margins.left ?? 0;
        if (x < left + fade) adj.value += (x - left - fade) * this._direction;
        else if (x + width > left + this.scroll.width - fade)
            adj.value += (x + width - left - this.scroll.width + fade) * this._direction;
    }

    _dragMotion(event) {
        const [x, y] = this.scroll.get_transformed_position();
        const edge = 24 * this._theme.scale_factor;
        this._dragDirection = event.y >= y && event.y <= y + this.scroll.height
            ? event.x < x + edge && event.x >= x ? -1
                : event.x > x + this.scroll.width - edge && event.x <= x + this.scroll.width ? 1 : 0
            : 0;
        if (!this._dragDirection) this._stopDragScroll();
        else if (!this._dragScrollId) {
            this._dragScrollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                this.scroll.hadjustment.value += this._dragDirection * this._direction * 12 * this._theme.scale_factor;
                return GLib.SOURCE_CONTINUE;
            });
        }
        return DND.DragMotionResult.CONTINUE;
    }

    _stopDragScroll() {
        if (this._dragScrollId) GLib.source_remove(this._dragScrollId);
        this._dragScrollId = 0;
    }

    destroy() {
        this._stopDragScroll();
        if (this._layoutId) global.compositor.get_laters().remove(this._layoutId);
        DND.removeDragMonitor(this._dragMonitor);
        this._dragEndIds.forEach(id => Main.overview.disconnect(id));
        this.scroll.hadjustment.disconnect(this._scrollId);
        global.stage.disconnect(this._focusId);
        this._theme.disconnect(this._scaleId);
        const dash = this.dash;
        dash.disconnect(this._styleId);
        dash._box.disconnect(this._addedId);
        dash._box.disconnect(this._removedId);
        dash._adjustIconSize = this._originalAdjust;
        for (const sizes of [this._itemSizes, this._buttonSizes, this._slotSizes]) {
            for (const [actor, size] of sizes) {
                const {destroyId, ...properties} = size;
                actor.disconnect(destroyId);
                actor.set(properties);
            }
            sizes.clear();
        }
        this.content.remove_child(dash._box);
        this.row.remove_child(dash._showAppsIcon);
        this._showAppsParent.insert_child_at_index(dash._showAppsIcon, this._showAppsIndex);
        this._parent.insert_child_at_index(dash._box, 0);
        dash._box.layout_manager = this._originalLayout;
        this.row.destroy();
        dash._adjustIconSize();
    }
}
