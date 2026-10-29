const { Pango } = imports.gi;

// Use one font-derived line height for explicit and visual line breaks.
function measure(text, width, color = null) {
    const source = text.get_layout();
    const context = source.get_context();
    const metrics = context.get_metrics(source.get_font_description(), context.get_language());
    const lineHeight = Math.ceil((metrics.get_ascent() + metrics.get_descent()) / Pango.SCALE);
    const styleKey = JSON.stringify([
        lineHeight,
        color?.red,
        color?.green,
        color?.blue,
        color?.alpha,
    ]);
    if (text._pingooseTextStyle !== styleKey) {
        // Keep existing attributes and explicitly retain the current St theme color.
        // Installing a fresh AttrList can otherwise restore Pango's black default.
        const attributes = source.get_attributes()?.copy() || new Pango.AttrList();
        attributes.change(Pango.attr_insert_hyphens_new(false));
        attributes.change(Pango.attr_line_height_new_absolute(lineHeight * Pango.SCALE));
        if (color) {
            attributes.change(
                Pango.attr_foreground_new(color.red * 257, color.green * 257, color.blue * 257)
            );
            attributes.change(Pango.attr_foreground_alpha_new(color.alpha * 257));
        }
        text.set_attributes(attributes);
        text._pingooseTextStyle = styleKey;
    }
    const layout = text.get_layout().copy();
    layout.set_width(Math.max(1, Math.floor(width)) * Pango.SCALE);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    return layout.get_line_count() * lineHeight;
}

// Pango positions use UTF-8 byte offsets, not JavaScript UTF-16 offsets.
function logicalLinePositions(text, width, value) {
    const layout = text.get_layout().copy();
    layout.set_width(Math.max(1, Math.floor(width)) * Pango.SCALE);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    layout.set_text(value, -1);
    let offset = 0;
    return value.split('\n').map((line) => {
        const position = layout.index_to_pos(offset);
        offset += imports.byteArray.fromString(line).length + 1;
        return { y: position.y / Pango.SCALE };
    });
}

// Measure the caret in the same wrapped layout as the editor, independent of
// Clutter.Text's internal scrolling offset during a text/allocation change.
function cursorBounds(text, width, value) {
    const layout = text.get_layout().copy();
    layout.set_width(Math.max(1, Math.floor(width)) * Pango.SCALE);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    layout.set_text(value, -1);
    const position = text.get_cursor_position();
    const prefix = position < 0 ? value : Array.from(value).slice(0, position).join('');
    const rectangle = layout.index_to_pos(imports.byteArray.fromString(prefix).length);
    return { y: rectangle.y / Pango.SCALE, height: rectangle.height / Pango.SCALE };
}
