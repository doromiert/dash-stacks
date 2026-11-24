import gi,sys,json
gi.require_version('Gtk','4.0');gi.require_version('Gdk','4.0');from gi.repository import Gtk,Gdk,Gio
root=sys.argv[1]
a=Gtk.Application(application_id='org.zenos.NativeDropProbe')
def activate(app):
 w=Gtk.ApplicationWindow(application=app,title='Native file drop target',default_width=500,default_height=400)
 target=Gtk.DropTarget.new(Gdk.FileList,Gdk.DragAction.COPY)
 def drop(_target,value,x,y):
  open(root+'/drop.json','w').write(json.dumps({'uris':[f.get_uri() for f in value.get_files()]}));return True
 target.connect('accept',lambda _t,d:(open(root+'/target-offer.json','w').write(json.dumps({'formats':d.get_formats().to_string()})),True)[-1]);target.connect('enter',lambda *_:(open(root+'/target-enter','w').write('yes'),Gdk.DragAction.COPY)[-1]);target.connect('drop',drop);w.add_controller(target);w.set_child(Gtk.Label(label='Drop a file here'));w.present()
a.connect('activate',activate);a.run([])
