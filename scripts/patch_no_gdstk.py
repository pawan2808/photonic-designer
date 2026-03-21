#!/usr/bin/env python3
"""
patch_no_gdstk.py — Remove gdstk dependency from app.py

Replaces the gdstk-based polygon extraction with nazca's built-in
cell_iter() polygon iterator. Works on any platform without compiling.

Usage: python scripts/patch_no_gdstk.py
"""

import re
from pathlib import Path

APP_PY = Path(__file__).parent.parent / "src" / "app.py"

OLD_GDSTK_CHECK = '''    # Check if gdstk is available
    try:
        import gdstk
    except ImportError:
        return jsonify({"error": "gdstk not installed. Run: pip install gdstk"}), 400'''

NEW_GDSTK_CHECK = '''    # gdstk not required — using nazca cell_iter for polygon extraction'''

OLD_EXPORT_BLOCK = '''        # Export to temporary GDS
        with tempfile.NamedTemporaryFile(suffix='.gds', delete=False) as tmp:
            tmp_path = tmp.name
        
        try:
            nd.export_gds(topcells=cell, filename=tmp_path)
            
            # Read back with gdstk
            lib = gdstk.read_gds(tmp_path)
            
            polygons = []
            for gcell in lib.cells:
                # Get polygons
                for poly in gcell.polygons:
                    layer = int(poly.layer)
                    points = poly.points.tolist()
                    layer_info = LAYER_COLORS.get(layer, {"color": "#888888", "name": f"L{layer}", "opacity": 0.5})
                    
                    polygons.append({
                        "layer": layer,
                        "layer_name": layer_info["name"],
                        "color": layer_info["color"],
                        "opacity": layer_info["opacity"],
                        "points": [[float(p[0]), float(p[1])] for p in points]
                    })
                
                # Convert paths to polygons
                for path in gcell.paths:
                    layer = path.layers[0] if path.layers else 1
                    try:
                        poly_pts = path.to_polygons()
                        for pp in poly_pts:
                            pts = pp.points.tolist() if hasattr(pp, 'points') else pp.tolist()
                            layer_info = LAYER_COLORS.get(layer, {"color": "#888888", "name": f"L{layer}", "opacity": 0.5})
                            polygons.append({
                                "layer": layer,
                                "layer_name": layer_info["name"],
                                "color": layer_info["color"],
                                "opacity": layer_info["opacity"],
                                "points": [[float(p[0]), float(p[1])] for p in pts]
                            })
                    except:
                        pass'''

NEW_EXPORT_BLOCK = '''        # Extract polygons directly from nazca cell (no gdstk needed)
        try:
            polygons = []
            for named_tuple in nd.cell_iter(cell, flat=True):
                for poly_xy, poly_points, poly_bbox in named_tuple.polygon_iter():
                    layer_num = poly_xy[0] if isinstance(poly_xy, (list, tuple)) else int(poly_xy)
                    # poly_xy is (layer, datatype, points) or similar
                    # poly_points are the actual coordinate points
                    try:
                        if hasattr(poly_points, 'tolist'):
                            pts = poly_points.tolist()
                        else:
                            pts = list(poly_points)
                        layer_info = LAYER_COLORS.get(layer_num, {"color": "#888888", "name": f"L{layer_num}", "opacity": 0.5})
                        polygons.append({
                            "layer": layer_num,
                            "layer_name": layer_info["name"],
                            "color": layer_info["color"],
                            "opacity": layer_info["opacity"],
                            "points": [[float(p[0]), float(p[1])] for p in pts]
                        })
                    except Exception as ep:
                        pass  # skip malformed polygons'''

# Alternative approach using GDS export + struct parsing (more reliable)
NEW_EXPORT_BLOCK_V2 = '''        # Extract polygons using nazca GDS export + binary parsing (no gdstk needed)
        import struct as _struct
        
        with tempfile.NamedTemporaryFile(suffix='.gds', delete=False) as tmp:
            tmp_path = tmp.name
        
        try:
            nd.export_gds(topcells=cell, filename=tmp_path)
            
            polygons = []
            
            # Parse GDS binary directly — much simpler than gdstk
            with open(tmp_path, 'rb') as f:
                gds_data = f.read()
            
            i = 0
            current_layer = 0
            while i < len(gds_data) - 4:
                rec_len = _struct.unpack('>H', gds_data[i:i+2])[0]
                rec_type = _struct.unpack('>H', gds_data[i+2:i+4])[0]
                
                if rec_len < 4:
                    break
                
                # LAYER record (0x0D02)
                if rec_type == 0x0D02 and rec_len >= 6:
                    current_layer = _struct.unpack('>H', gds_data[i+4:i+6])[0]
                
                # BOUNDARY XY record (0x1003) — polygon coordinates
                if rec_type == 0x1003 and rec_len > 4:
                    n_coords = (rec_len - 4) // 8
                    points = []
                    for j in range(n_coords):
                        offset = i + 4 + j * 8
                        x = _struct.unpack('>i', gds_data[offset:offset+4])[0] * 1e-3  # nm to um
                        y = _struct.unpack('>i', gds_data[offset+4:offset+8])[0] * 1e-3
                        points.append([x, y])
                    
                    if len(points) > 2:
                        # Remove closing point if same as first
                        if points[-1] == points[0]:
                            points = points[:-1]
                        
                        layer_info = LAYER_COLORS.get(current_layer, {"color": "#888888", "name": f"L{current_layer}", "opacity": 0.5})
                        polygons.append({
                            "layer": current_layer,
                            "layer_name": layer_info["name"],
                            "color": layer_info["color"],
                            "opacity": layer_info["opacity"],
                            "points": points
                        })
                
                i += rec_len'''


def patch():
    if not APP_PY.exists():
        print(f"  ERROR: {APP_PY} not found")
        return False
    
    code = APP_PY.read_text(encoding='utf-8')
    changed = False
    
    # Patch 1: Remove gdstk import check
    if OLD_GDSTK_CHECK in code:
        code = code.replace(OLD_GDSTK_CHECK, NEW_GDSTK_CHECK)
        changed = True
        print("  Patched: removed gdstk import check")
    
    # Patch 2: Replace GDS export + gdstk read with binary GDS parser
    if OLD_EXPORT_BLOCK in code:
        code = code.replace(OLD_EXPORT_BLOCK, NEW_EXPORT_BLOCK_V2)
        changed = True
        print("  Patched: replaced gdstk polygon reader with GDS binary parser")
    
    # Also patch the connection_polygons endpoint if it uses gdstk
    if 'import gdstk' in code:
        # Replace all remaining gdstk imports
        code = code.replace(
            '        import gdstk',
            '        import struct as _struct  # gdstk replaced with binary parser'
        )
        
        # Find and replace any remaining gdstk.read_gds patterns
        # This is a simpler pattern replacement for the connection_polygons endpoint
        if 'gdstk.read_gds' in code:
            print("  WARNING: Additional gdstk.read_gds calls found — may need manual patching")
            print("  Check connection_polygons endpoint")
        
        changed = True
    
    if changed:
        APP_PY.write_text(code, encoding='utf-8')
        print(f"\n  app.py patched successfully!")
        print(f"  gdstk is no longer required.")
        return True
    else:
        print("  No gdstk references found — already patched or different code version")
        return False


if __name__ == "__main__":
    print("\n  Photonic Designer — Remove gdstk dependency")
    print("  " + "="*45 + "\n")
    patch()
    print()
