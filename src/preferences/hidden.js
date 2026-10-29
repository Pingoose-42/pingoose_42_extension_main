const {Gtk,Gio}=imports.gi;
const Me=imports.misc.extensionUtils.getCurrentExtension();
function build(settings){
    const box=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:18});
    for(const [key,label] of [['hidden-cluster-chat','Cluster Chat'],['hidden-auto-slots','Auto Open Evaluation Slots'],['hidden-dev-options','Add Developer Options']]){
        Me.imports.preferences.common.sectionHeading(box, {'hidden-cluster-chat':'Cluster Chat', 'hidden-auto-slots':'Automatic Slots', 'hidden-dev-options':'Developer Tools'}[key], key !== 'hidden-cluster-chat');
        const toggle=new Gtk.Switch({active:Me.imports.models.featureFlags.enabled(settings,key),valign:Gtk.Align.CENTER});
        box.connect('map',()=>{toggle.active=Me.imports.models.featureFlags.enabled(settings,key);});
        toggle.connect('notify::active',()=>settings.set_boolean(key,toggle.active));
        Me.imports.preferences.common.row(box,label,toggle);
        if(key==='hidden-cluster-chat'){
            const blocks=new Gtk.Button({label:'Manage Block List'});
            blocks.connect('clicked',()=>Me.imports.preferences.chatBlocks.open(box,settings));
            box.append(blocks);
        }
        if(key==='hidden-auto-slots'){
            for(const [setting,title,max] of [
                ['auto-slot-duration-units','Slot length (1–16 × 15 min)',16],
                ['auto-slot-interval-units','Gap after slot (1–96 × 15 min)',96],
                ['auto-slot-count','Number of slots (1–20)',20]]){
                const spin=Gtk.SpinButton.new_with_range(1,max,1);
                settings.bind(setting,spin,'value',Gio.SettingsBindFlags.DEFAULT);
                Me.imports.preferences.common.row(box,title,spin);
            }
        }

    }
    const role=new Gtk.ComboBoxText();
    role.append('evaluator','Evaluator');role.append('evaluated','Evaluatee');
    settings.bind('dev-evaluation-role',role,'active-id',Gio.SettingsBindFlags.DEFAULT);
    Me.imports.preferences.common.row(box,'Test Evaluation Role',role);
    const offset=new Gtk.SpinButton({
        adjustment:new Gtk.Adjustment({lower:-10080,upper:10080,step_increment:1,page_increment:10}),
        numeric:true,digits:0,valign:Gtk.Align.CENTER,
    });
    offset.set_value(settings.get_int('dev-evaluation-offset-minutes'));
    offset.connect('value-changed',()=>settings.set_int('dev-evaluation-offset-minutes',offset.get_value_as_int()));
    Me.imports.preferences.common.row(box,'Test Evaluation Start Offset (−10080–10080 min)',offset);
    return box;
}
