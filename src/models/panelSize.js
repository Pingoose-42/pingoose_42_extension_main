// Heights are actor-local pixels. Pointer coordinates and work areas are in stage space.
var EDGE_SIZE = 7;
var MINIMUM_VIEWPORT = 64;

function clamp(height, minimum, maximum) {
    const limit = Math.max(1, Math.min(4096, Math.floor(maximum)));
    const floor = Math.min(limit, Math.max(1, Math.ceil(minimum)));
    return Math.max(floor, Math.min(limit, Math.round(height)));
}

function isResizeEdge(x, y, width, height, bottom, edge = EDGE_SIZE) {
    if (x < 0 || x > width || y < 0 || y > height) return false;
    return bottom ? y <= edge : y >= height - edge;
}

function dragHeight(startHeight, startY, y, scale, bottom, minimum, maximum) {
    const delta = (y - startY) / Math.max(0.01, scale);
    return clamp(startHeight + (bottom ? -delta : delta), minimum, maximum);
}

function availableHeight(workArea, anchor, bottom, margin, scale = 1) {
    const distance = bottom ? anchor - workArea.y : workArea.y + workArea.height - anchor;
    return Math.max(1, Math.floor(distance / Math.max(0.01, scale) - margin));
}
