const GLib = imports.gi.GLib;
imports.searchPath.unshift(
    GLib.path_get_dirname(GLib.path_get_dirname(imports.system.programPath))
);
const { Pango, PangoCairo } = imports.gi;
const context = PangoCairo.FontMap.get_default().create_context();
function actor(value) {
    const l = Pango.Layout.new(context);
    l.set_font_description(Pango.FontDescription.from_string('Sans 11'));
    l.set_text(value, -1);
    return { get_layout: () => l, set_attributes: (a) => l.set_attributes(a) };
}
const measure = imports.ui.noteTextLayout.measure;
const soft = actor('abcdefghij'.repeat(6));
measure(soft, 100);
const wrapped = soft.get_layout().copy();
wrapped.set_width(100 * Pango.SCALE);
wrapped.set_wrap(Pango.WrapMode.WORD_CHAR);
const count = wrapped.get_line_count();
const hard = actor(Array(count).fill('text').join('\n'));
if (measure(soft, 100) !== measure(hard, 100)) throw Error('Line heights differ');
if (!soft.get_layout().get_attributes().to_string().includes('insert-hyphens false'))
    throw Error('Hyphenation enabled');
print(
    'PASS: ' + count + ' wrapped and explicit lines have equal height; inserted hyphens disabled'
);

const white = { red: 238, green: 238, blue: 238, alpha: 255 };
const black = { red: 25, green: 25, blue: 25, alpha: 255 };
measure(soft, 100, white);
const first = soft.get_layout().get_attributes().to_string();
measure(soft, 160, white);
if (soft.get_layout().get_attributes().to_string() !== first) throw Error('Resize changed color');
measure(soft, 100, black);
const dark = soft.get_layout().get_attributes().to_string();
if (dark === first || !dark.includes('foreground')) throw Error('Theme color did not update');
measure(soft, 100, white);
if (
    soft.get_layout().get_attributes().to_string().split('\n').sort().join('\n') !==
    first.split('\n').sort().join('\n')
)
    throw Error('Original theme color not restored');
print('PASS: resize preserves text color and theme changes restore matching foreground');

const positions = imports.ui.noteTextLayout.logicalLinePositions;
const editor = actor('');
measure(editor, 100, white);
const empty = positions(editor, 100, '\nsecond');
const typed = positions(editor, 100, 'a\nsecond');
if (empty[0].y !== typed[0].y || empty[1].y !== typed[1].y)
    throw Error('Typing moved line numbers without wrapping');
const unicode = positions(editor, 100, '한글🙂\nsecond\n');
if (unicode.length !== 3 || unicode[1].y <= unicode[0].y || unicode[2].y <= unicode[1].y)
    throw Error('Unicode or empty trailing line offsets failed');
const long = positions(editor, 100, 'abcdefghij'.repeat(6) + '\nsecond');
if (long.length !== 2 || long[1].y <= typed[1].y)
    throw Error('Wrapped paragraphs did not preserve logical numbering');
print(
    'PASS: line numbers stay stable while typing and follow wrapping, Unicode, and trailing newlines'
);

const caret = imports.ui.noteTextLayout.cursorBounds;
const caretActor = actor('가나다 abc '.repeat(100));
caretActor.get_cursor_position = () => -1;
const end = caret(caretActor, 100, '가나다 abc '.repeat(100));
caretActor.get_cursor_position = () => 8;
const middle = caret(caretActor, 100, '가나다 abc '.repeat(100));
if (end.y <= middle.y || middle.y < 0 || end.height <= 0)
    throw Error('Wrapped caret position invalid');
caretActor.get_cursor_position = () => -1;
const newline = caret(caretActor, 100, 'a\nb\n');
const before = caret(caretActor, 100, 'a\nb');
if (newline.y <= before.y) throw Error('Trailing newline does not reveal the next line');
print('PASS: caret bounds track Unicode, soft wrapping, middle edits and trailing newlines');
