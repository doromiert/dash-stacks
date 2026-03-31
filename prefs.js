import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DashStacksPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- new general options block ---
        let generalGroup = new Adw.PreferencesGroup({ title: 'General Options' });
        page.add(generalGroup);

        const addSpinRow = (title, key, min, max) => {
            let row = new Adw.SpinRow({ 
                title: title,
                adjustment: new Gtk.Adjustment({
                    lower: min, upper: max, step_increment: 1,
                    value: settings.get_int(key)
                })
            });
            row.connect('notify::value', () => settings.set_int(key, row.value));
            generalGroup.add(row);
        };

        addSpinRow('Popup Width', 'popup-width', 200, 1000);
        addSpinRow('Popup Height', 'popup-height', 200, 1000);
        addSpinRow('Icon Size', 'icon-size', 16, 128);
        addSpinRow('Tooltip Delay (ms)', 'tooltip-delay', 0, 2000);
        // ---------------------------------

        let group = null; 
        const renderList = () => {
            if (group) {
                page.remove(group);
            }

            group = new Adw.PreferencesGroup({
                title: 'Stacks Configuration',
                description: 'Manage your dash folder stacks.'
            });
            page.add(group);

            let stacks = [];
            try {
                stacks = JSON.parse(settings.get_string('stacks'));
            } catch (e) {
                console.error('Failed to parse stacks:', e);
            }

            stacks.forEach((stack, index) => {
                let row = new Adw.ExpanderRow({ title: stack.name || 'Unnamed Stack' });
                
                let nameEntry = new Adw.EntryRow({ title: 'Name', text: stack.name });
                nameEntry.connect('changed', () => {
                    stacks[index].name = nameEntry.text;
                    row.title = nameEntry.text || 'Unnamed Stack';
                    save(stacks);
                });

                let pathEntry = new Adw.EntryRow({ title: 'Path', text: stack.path });
                pathEntry.connect('changed', () => {
                    stacks[index].path = pathEntry.text;
                    save(stacks);
                });

                let autoIconRow = new Adw.SwitchRow({ 
                    title: 'Auto-generate Grid Icon',
                    subtitle: 'Creates an icon based on folder contents'
                });
                autoIconRow.active = !!stack.autoIcon;

                let iconEntry = new Adw.EntryRow({ title: 'Icon Name', text: stack.icon });
                iconEntry.sensitive = !autoIconRow.active; // disable if auto is on

                autoIconRow.connect('notify::active', () => {
                    stacks[index].autoIcon = autoIconRow.active;
                    iconEntry.sensitive = !autoIconRow.active;
                    save(stacks);
                });

                iconEntry.connect('changed', () => {
                    stacks[index].icon = iconEntry.text;
                    save(stacks);
                });

                let deleteBtn = new Gtk.Button({
                    label: 'Remove Stack',
                    margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
                    css_classes: ['destructive-action']
                });
                deleteBtn.connect('clicked', () => {
                    stacks.splice(index, 1);
                    save(stacks);
                    renderList(); 
                });

                row.add_row(nameEntry);
                row.add_row(autoIconRow);
                row.add_row(pathEntry);
                row.add_row(iconEntry);
                row.add_row(deleteBtn);
                group.add(row);
            });

            let addRow = new Adw.ActionRow({ title: 'Add New Stack' });
            let addBtn = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER });
            addBtn.connect('clicked', () => {
                stacks.push({ name: 'New Stack', path: '~/', icon: 'folder' });
                save(stacks);
                renderList(); 
            });
            addRow.add_suffix(addBtn);
            group.add(addRow);
        };

        const save = (stacks) => {
            settings.set_string('stacks', JSON.stringify(stacks));
        };

        renderList();
    }
}
