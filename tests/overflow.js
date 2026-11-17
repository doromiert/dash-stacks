import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {resolve(); return GLib.SOURCE_REMOVE;}));
const assert = (condition, message) => {if (!condition) throw new Error(message);};
export async function runOverflow(extension) {
    const dash = Main.overview.dash;
    const settings = extension.getSettings();
    const original = settings.get_string('stacks');
    const context = St.ThemeContext.get_for_stage(global.stage);
    const scale = context.scale_factor;
    const samples = [];
    const snapshot = async name => {
        const stream = Gio.File.new_for_path(`/tmp/dock-${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
        try { await new Shell.Screenshot().screenshot(false, stream); }
        finally { stream.close(null); }
    };
    const settleGeometry = async () => {
        let previous, stable=0;
        const deadline=GLib.get_monotonic_time()+2_000_000;
        while(stable<3){
            await delay(40);
            const actors=[dash,dash._background,...dash._box.get_children(),dash._showAppsIcon,dash._showAppsIcon.icon];
            const geometry=JSON.stringify(actors.map(actor=>[...actor.get_transformed_position(),...actor.get_transformed_size()]));
            stable=geometry===previous&&!extension._dock._layoutId?stable+1:0;previous=geometry;
            assert(GLib.get_monotonic_time()<deadline,'dock allocations did not settle');
        }
    };
    const checkTiles = () => {
        const items = [...dash._box.get_children(), dash._showAppsIcon].filter(i => i.child?._delegate?.icon);
        const bounds = items.map(i => i.get_size());
        assert(bounds.every(([w,h]) => w === h && w === bounds[0][0]), 'unequal/non-square item slots: '+JSON.stringify({bounds,iconSize:dash.iconSize,scale:context.scale_factor,maxH:dash._maxHeight,row:extension._dock.row.get_size(),scroll:extension._dock.scroll.get_size(),preferred:dash._showAppsIcon.child.get_preferred_size(),item:dash._showAppsIcon.get_preferred_size()}));
        const icons = items.map(i => i.child._delegate.icon);
        const sizes = icons.map(icon => icon.get_size());
        assert(sizes.every(([w,h]) => w === h && w === sizes[0][0]), 'unequal/non-square tiles: '+JSON.stringify(sizes));
        assert(icons.every(icon => icon.iconSize === dash.iconSize && icon.icon.width === dash.iconSize*context.scale_factor && icon.icon.height === dash.iconSize*context.scale_factor), 'a dock icon shrank');
        assert(context.scale_factor !== 1 || dash.iconSize === 64, 'item count shrank the dock');
        const [sx] = dash._showAppsIcon.get_transformed_position();
        assert(sx >= 0 && sx + dash._showAppsIcon.width <= global.stage.width, 'Show Apps off screen: '+JSON.stringify({sx,width:dash._showAppsIcon.width,stage:global.stage.width,max:dash._maxWidth,scroll:extension._dock.scroll.width,row:extension._dock.row.width,style:extension._dock.scroll.style,scale:context.scale_factor}));
        for (const item of items.filter(i=>i._stackButton)) {
            const button = item._stackButton;
            const [w,h] = button.mainIcon.get_size();
            const limit = dash.iconSize*context.scale_factor;
            assert(w <= limit && h <= limit, `stack artwork escaped tile ${w}/${h}/${limit}`);
        }
        const [bx,by] = dash._background.get_transformed_position();
        const [bw,bh] = dash._background.get_transformed_size();
        const appButton = items.find(item => item.child?._dot)?.child;
        assert(appButton, 'running-dot fixture missing');
        const artwork = appButton.icon.icon;
        const dot = appButton._dot;
        const [artX, artY] = artwork.get_transformed_position();
        const [dotX, dotY] = dot.get_transformed_position();
        const [artW, artH] = artwork.get_transformed_size();
        const [dotW, dotH] = dot.get_transformed_size();
        const dotGap = dotY - artY - artH;
        assert(dotGap > 0 && dotY + dotH <= by + bh,
            `running dot overlaps app artwork or leaves the dock: gap ${dotGap}px`);
        assert(Math.abs(dotX + dotW / 2 - artX - artW / 2) <= 1,
            'running dot is not centered below the artwork');
        const [fx,fy] = icons[0].get_transformed_position();
        const [lastX,lastY] = dash._showAppsIcon.icon.get_transformed_position();
        const vertical = lastY-by;
        const right = bx+bw-lastX-sizes.at(-1)[0];
        assert(Math.abs(right-vertical)<1, `right/vertical padding differ ${right}/${vertical}: ${JSON.stringify({style:dash._background.style,dashStyle:dash.style,background:[bx,by,bw,bh],last:[lastX,lastY,...sizes.at(-1)],maxH:dash._maxHeight,scale:context.scale_factor})}`);
        if (extension._dock.scroll.hadjustment.value < 0.1)
            assert(Math.abs(fx-bx-vertical)<1, `left/vertical padding differ ${fx-bx}/${vertical}`);
        const [dashX,dashY]=dash.get_transformed_position(),[dashW,dashH]=dash.get_transformed_size();
        const outer={left:bx-dashX,right:dashX+dashW-bx-bw,bottom:dashY+dashH-by-bh};
        if(extension._dock.scroll.hadjustment.upper>extension._dock.scroll.hadjustment.page_size+1)
            assert(Math.abs(outer.left-outer.bottom)<1&&Math.abs(outer.right-outer.bottom)<1, 'outer dock gaps differ '+JSON.stringify(outer));
        samples.push({scale:context.scale_factor, tiles: sizes.length, size:sizes[0], iconSize:dash.iconSize,dotGap,padding:{left:fx-bx,right,vertical,outer}});
    };
    const dot = dash._box.get_children().find(item => item.child?._dot)?.child._dot;
    assert(dot, 'running-dot fixture missing');
    dot.show();
    const started = GLib.get_monotonic_time();
    settings.set_string('stacks', JSON.stringify(Array.from({length:24}, (_,i) => ({name:`Folder ${i+1}`,path:'/tmp',icon:'folder',autoIcon:i===1}))));
    await delay(180);
    checkTiles();
    const dock = extension._dock;
    const scroll = dock.scroll;
    const adj = scroll.hadjustment;
    assert(adj.upper > adj.page_size + 500, `overflow not scrollable: ${adj.upper}/${adj.page_size}`);
    const feedbackMs=(GLib.get_monotonic_time()-started)/1000;
    assert(feedbackMs < 400, `slow overflow feedback ${feedbackMs}`);
    assert(scroll.width + dash._showAppsIcon.width <= dash._maxWidth+1, 'viewport ignores native available width');
    const fade = scroll.get_effect('fade');
    assert(fade && !fade.fade_edges && fade.fade_margins.left > 0 && fade.fade_margins.right > 0, 'native directional fade missing');
    adj.value=0;
    await delay(60);
    assert(fade.enabled, 'overflow fade disabled');
    await snapshot('start');
    const pointer = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const [x,y] = scroll.get_transformed_position();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x+scroll.width/2,y+scroll.height/2);
    pointer.notify_discrete_scroll(GLib.get_monotonic_time(),Clutter.ScrollDirection.DOWN,Clutter.ScrollSource.WHEEL);
    await delay(100);
    assert(adj.value > 0, 'physical mouse wheel did not scroll');
    const wheelValue = adj.value;
    pointer.notify_scroll_continuous(GLib.get_monotonic_time(),1,0,Clutter.ScrollSource.FINGER,Clutter.ScrollFinishFlags.NONE);
    await delay(100);
    assert(adj.value > wheelValue, 'smooth horizontal scrolling failed');
    const touch = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN);
    adj.value=0;
    const beforeTouch = adj.value;
    const touchTrace=[];
    dock._pan.connect('recognize',()=>touchTrace.push('recognize'));
    dock._pan.connect('pan-update',()=>touchTrace.push(dock._pan.get_delta_abs().get_x()));
    touch.notify_touch_down(GLib.get_monotonic_time(),0,x+scroll.width/2,y+scroll.height/2);
    for (let step=1;step<=10;step++) {
        await delay(12);
        touch.notify_touch_motion(GLib.get_monotonic_time(),0,x+scroll.width/2-step*12,y+scroll.height/2);
    }
    touch.notify_touch_up(GLib.get_monotonic_time(),0);
    await delay(20);
    const touchRelease=adj.value;
    await delay(100);
    assert(adj.value>touchRelease+1,'touch kinetic scrolling stopped on release');
    assert(adj.value > beforeTouch, 'physical touch swipe did not scroll: '+JSON.stringify({beforeTouch,after:adj.value,upper:adj.upper,page:adj.page_size,trace:touchTrace,state:dock._pan.get_state(),pick:String(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,x+scroll.width/2,y+scroll.height/2))}));
    assert(!extension._buttons.some(i=>i._stackButton?.popup), 'swipe activated a stack');
    dock._stopMomentum();adj.value=0;
    for(let step=0;step<6;step++){
        pointer.notify_scroll_continuous(GLib.get_monotonic_time(),0.2,0,Clutter.ScrollSource.FINGER,Clutter.ScrollFinishFlags.NONE);
        await delay(16);
    }
    pointer.notify_scroll_continuous(GLib.get_monotonic_time(),0,0,Clutter.ScrollSource.FINGER,Clutter.ScrollFinishFlags.HORIZONTAL);
    await delay(20);const padRelease=adj.value;
    await delay(100);assert(adj.value>padRelease+1,'trackpad kinetic scrolling stopped on release');
    pointer.notify_discrete_scroll(GLib.get_monotonic_time(),Clutter.ScrollDirection.UP,Clutter.ScrollSource.WHEEL);
    await delay(30);const interrupted=adj.value;
    await delay(100);assert(Math.abs(adj.value-interrupted)<1,'new wheel input did not interrupt kinetic scrolling');
    dock._stopMomentum();
    adj.value=(adj.upper-adj.page_size)/2;
    await delay(60);
    await snapshot('middle');
    const last = dash._box.get_children().filter(i=>i._stackButton).at(-1);
    last.child.grab_key_focus();
    await delay(100);
    const [lastX] = last.get_transformed_position();
    assert(lastX >= x && lastX+last.width <= x+scroll.width+1, 'keyboard focus not revealed');
    dash.showAppsButton.grab_key_focus();
    adj.value=adj.upper-adj.page_size;
    await delay(60);
    await snapshot('end');
    const beforeDrag = adj.value;
    dock._dragMotion({x:x+1,y:y+scroll.height/2});
    await delay(100);
    dock._stopDragScroll();
    assert(adj.value < beforeDrag, 'drag edge did not scroll');
    context.scale_factor=2;
    await delay(180);
    await settleGeometry();
    await snapshot('scale2');
    checkTiles();
    context.scale_factor=scale;
    await delay(180);
    await settleGeometry();
    checkTiles();
    settings.set_string('stacks', original);
    await delay(180);
    checkTiles();
    const fit = extension._dock.scroll;
    assert(fit.hadjustment.upper <= fit.hadjustment.page_size+1, 'fitting dock still overflows');
    assert(fit.hadjustment.value === 0 && !fit.get_effect('fade').enabled, 'fades/offset remain after removing overflow');
    await snapshot('fit');
    dot.hide();
    extension.disable();
    assert(dash._box.get_parent() === dash._dashContainer && dash._showAppsIcon.get_parent() === dash._dashContainer, 'native parenting not restored');
    extension.enable();
    await delay(180);
    checkTiles();
    return {feedbackMs,samples,kineticTouch:true,kineticTrackpad:true,interrupt:true,wheel:true,touchpad:true,touch:true,keyboard:true,dragEdge:true,nativeFade:true,lifecycle:true};
}
