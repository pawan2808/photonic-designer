# app.py  —  Photonic Designer Backend (self-contained, no lib file needed)
# Run:  python app.py
# API:  http://localhost:5000

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import os, sys, traceback, tempfile

app = Flask(__name__)
# Allow CORS from any origin (localhost, 127.0.0.1, etc.)
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ── Try loading nazca + IHP_PDK ───────────────────────────────────────────────
NAZCA_AVAILABLE = False
try:
    import nazca as nd
    import nazca.geometries as geom
    import numpy as np
    import IHP_PDK as ihp
    NAZCA_AVAILABLE = True
    print("[OK] nazca + IHP_PDK loaded")
except ImportError as e:
    print(f"[WARN] {e} — code generation works, GDS export needs nazca + IHP_PDK")


# ═════════════════════════════════════════════════════════════════════════════
#  COMPONENT BUILDERS  (inlined — used for GDS export)
# ═════════════════════════════════════════════════════════════════════════════

def _pdk():
    class _L:
        wg  = ihp.IC_SiNBWG
        grt = ihp.IC_GRT
        grb = ihp.IC_GRB
        gps = ihp.IC_GPS
        gm1 = ihp.IC_GM1   # layer 109
        gct = ihp.IC_GCT   # layer 97
    return _L()


# ── Grating Coupler ──────────────────────────────────────────────────────────
def _GratingCoupler(comp_id, p):
    """
    Custom Grating Coupler with a0 pin at the narrow (waveguide) end on LEFT.
    Structure: Narrow waveguide (left, a0) -> taper -> wide grating end (right, b0)
    """
    period    = float(p["period"])
    ff        = float(p["ff"])
    tp_width  = float(p.get("tp_width", 10.0))   # wide end width
    wg_width  = float(p.get("wg_width", 0.7))    # narrow end width
    tp_length = float(p.get("taper_len", 250))   # total length
    N         = int(p.get("N", 20))              # number of grating teeth
    
    # Grating section parameters
    grating_length = period * N
    cap_len = 10  # end caps
    taper_len = tp_length - grating_length - 2 * cap_len
    
    if taper_len < 10:
        taper_len = 10
        tp_length = taper_len + grating_length + 2 * cap_len
    
    with nd.Cell(f"GC_{comp_id}") as C:
        # Build from left (narrow) to right (wide)
        # x=0 is at the LEFT (narrow waveguide end) - this is where a0 is
        
        x = 0
        
        # Pin a0 at the narrow end (left side, x=0) - this is where waveguides connect
        nd.Pin('a0').put(0, 0, 180)
        
        # 1. Short waveguide stub at input (narrow end)
        stub_len = 5
        nd.Polygon(layer=119, points=[
            (x, -wg_width/2),
            (x + stub_len, -wg_width/2),
            (x + stub_len, wg_width/2),
            (x, wg_width/2)
        ]).put(0, 0)
        x += stub_len
        
        # 2. Taper from narrow to wide
        nd.Polygon(layer=119, points=[
            (x, -wg_width/2),
            (x + taper_len, -tp_width/2),
            (x + taper_len, tp_width/2),
            (x, wg_width/2)
        ]).put(0, 0)
        x += taper_len
        
        # 3. Left cap before grating
        nd.Polygon(layer=119, points=[
            (x, -tp_width/2),
            (x + cap_len, -tp_width/2),
            (x + cap_len, tp_width/2),
            (x, tp_width/2)
        ]).put(0, 0)
        x += cap_len
        
        # 4. Grating section - CONTINUOUS SiNWG underneath, SiNGrating on top for etch pattern
        grating_start = x
        
        # First: continuous SiNWG layer for the entire grating region
        nd.Polygon(layer=119, points=[
            (grating_start, -tp_width/2),
            (grating_start + grating_length, -tp_width/2),
            (grating_start + grating_length, tp_width/2),
            (grating_start, tp_width/2)
        ]).put(0, 0)
        
        # Second: SiNGrating layer on top for the etched teeth pattern
        for i in range(N):
            tooth_width = period * ff
            gap_width = period * (1 - ff)
            
            # Grating tooth (SiNGrating layer 88) - defines the etch pattern
            nd.Polygon(layer=88, points=[
                (x, -tp_width/2),
                (x + tooth_width, -tp_width/2),
                (x + tooth_width, tp_width/2),
                (x, tp_width/2)
            ]).put(0, 0)
            x += tooth_width + gap_width
        
        # 5. Right cap (wide end)
        nd.Polygon(layer=119, points=[
            (x, -tp_width/2),
            (x + cap_len, -tp_width/2),
            (x + cap_len, tp_width/2),
            (x, tp_width/2)
        ]).put(0, 0)
        x += cap_len
        
        # Pin b0 at the wide end (right side) - fiber coupling side
        nd.Pin('b0').put(x, 0, 0)
        
        nd.put_stub()
    
    return C


# ── Graphene + Vias for Ring/Racetrack ───────────────────────────────────────
def _place_graphene_and_vias(L, ring_inst, radius, wg_width, theta, theta1,
                              via_size, via_gap, layer_spacing,
                              coupling_length=0, pad_size=80,
                              pad_open_factor=0.4, pad_distance=0.15):
    top_graphene_width = wg_width * 11
    bot_graphene_width = wg_width * 11
    channel_width      = 20

    pin_gt1 = nd.Pin('a1').put(ring_inst.pin['a0'].move(-radius + 5*wg_width, -radius, -90))
    pin_gt2 = nd.Pin('b1').put(ring_inst.pin['a0'].move(-radius + 5*wg_width, -radius,  90))
    pin_gb1 = nd.Pin('a2').put(ring_inst.pin['a0'].move(-radius - 5*wg_width, -radius, -90))
    pin_gb2 = nd.Pin('b2').put(ring_inst.pin['a0'].move(-radius - 5*wg_width, -radius,  90))

    L.grt.bend(radius=radius - 5*wg_width, angle= theta1, width=top_graphene_width).put(pin_gt1)
    L.grt.bend(radius=radius - 5*wg_width, angle=-theta,  width=top_graphene_width).put(pin_gt2)

    gm1_top_r = radius - top_graphene_width/2 - channel_width/2 + wg_width
    L.gm1.bend(radius=gm1_top_r, angle= theta1, width=channel_width).put(pin_gt1.move(0,  channel_width/2))
    L.gm1.bend(radius=gm1_top_r, angle=-theta,  width=channel_width).put(pin_gt2.move(0, -channel_width/2))

    L.grb.bend(radius=radius + 5*wg_width, angle= theta1, width=bot_graphene_width).put(pin_gb1)
    L.grb.bend(radius=radius + 5*wg_width, angle=-theta,  width=bot_graphene_width).put(pin_gb2)

    eps   = (0.05 / (radius + 5*wg_width)) * 57.3
    gps_w = bot_graphene_width + 0.1
    L.gps.bend(radius=radius + 5*wg_width, angle= theta1+eps, width=gps_w).put(pin_gb1)
    L.gps.bend(radius=radius + 5*wg_width, angle=-(theta+eps), width=gps_w).put(pin_gb2)

    gm1_bot_r = radius + top_graphene_width/2 + channel_width/2 - wg_width
    L.gm1.bend(radius=gm1_bot_r, angle= theta1, width=channel_width).put(pin_gb1.move(0, -channel_width/2))
    L.gm1.bend(radius=gm1_bot_r, angle=-theta,  width=channel_width).put(pin_gb2.move(0,  channel_width/2))

    pin_gmtop = nd.Pin('mt1').put(ring_inst.pin['a0'].move(coupling_length/2, -radius, -90))
    nd.Polygon(layer=109, points=geom.circle(radius=radius-20+coupling_length/2, N=1000)).put(pin_gmtop)
    nd.Polygon(layer=97,  points=geom.circle(radius=radius-30, N=1000)).put(pin_gmtop)

    if pad_size > 0:
        pin_gmbot = nd.Pin('mt2').put(
            ring_inst.pin['a0'].move(-radius - pad_distance - pad_size - 2*bot_graphene_width,
                                      -radius - pad_size/2))
        nd.Polygon(layer=109, points=geom.rectangle(length=pad_size, height=pad_size)).put(pin_gmbot)
        s_inner = pad_size * (1.0 - pad_open_factor)
        nd.Polygon(layer=97,  points=geom.rectangle(length=s_inner, height=s_inner)).put(
            pin_gmbot.move(pad_open_factor*pad_size/2, pad_open_factor*pad_size/2))

    pin_via = nd.Pin('vialeft').put(ring_inst.pin['a0'].move(0, -radius, -90))
    for r_base, sign in [(radius - channel_width/4.5, -1), (radius + channel_width/5.0, +1)]:
        for layer in range(4):
            adj_r = r_base + sign * layer * layer_spacing
            for arc_half, ang_sign in [(theta1, +1), (theta, -1)]:
                eff = 2*np.pi*adj_r*(arc_half/360)
                n   = max(1, int(eff / (via_size + via_gap)))
                for i in range(n):
                    angle = ang_sign * arc_half * i / n
                    vx = pin_via.x + adj_r * np.cos(np.deg2rad(angle))
                    vy = pin_via.y + adj_r * np.sin(np.deg2rad(angle))
                    nd.Polygon(layer=85,
                               points=[(0,0),(via_size,0),(via_size,via_size),(0,via_size)]
                               ).put(vx, vy, angle)


def _RingModulator(comp_id, p):
    radius          = float(p["radius"])
    gap             = float(p["gap"])
    graphene_length = float(p["gr_length"])
    wg_width        = float(p.get("wg_width", 0.7))
    via_size        = float(p.get("via_size", 0.5))
    via_gap         = float(p.get("via_gap", 0.4))
    layer_spacing   = float(p.get("layer_spacing", 0.8))
    pad_size        = float(p.get("pad_size", 80))
    pad_open_factor = float(p.get("pad_open_factor", 0.4))
    pad_distance    = float(p.get("pad_distance", 0.15))
    L = _pdk()

    gt = (180/np.pi) * (graphene_length/radius)
    theta  = min(gt/2, 40) if gt > 80 else gt/2
    theta1 = gt - theta    if gt > 80 else gt/2

    with nd.Cell(f"Ring_{comp_id}") as C:
        bus  = L.wg.strt(length=2*radius, width=wg_width).put(0, 0)
        nd.Pin('a0').put(bus.pin['a0'])
        nd.Pin('b0').put(bus.pin['b0'])
        ring = L.wg.bend(radius=radius, angle=360, width=wg_width).put(
            bus.pin['b0'].move(-radius, wg_width+gap))
        _place_graphene_and_vias(L, ring, radius, wg_width, theta, theta1,
                                  via_size, via_gap, layer_spacing,
                                  coupling_length=0,
                                  pad_size=pad_size, pad_open_factor=pad_open_factor,
                                  pad_distance=pad_distance)
        nd.put_stub()
    return C


def _RacetrackModulator(comp_id, p):
    radius          = float(p["radius"])
    gap             = float(p["gap"])
    graphene_length = float(p["gr_length"])
    coupling_length = float(p.get("coupling_length", 10))
    wg_width        = float(p.get("wg_width", 0.7))
    via_size        = float(p.get("via_size", 0.5))
    via_gap         = float(p.get("via_gap", 0.4))
    layer_spacing   = float(p.get("layer_spacing", 0.8))
    pad_size        = float(p.get("pad_size", 80))
    pad_open_factor = float(p.get("pad_open_factor", 0.4))
    pad_distance    = float(p.get("pad_distance", 0.15))
    L = _pdk()

    gt = (180/np.pi) * (graphene_length/radius)
    theta  = min(gt/2, 40) if gt > 80 else gt/2
    theta1 = gt - theta    if gt > 80 else gt/2

    with nd.Cell(f"RT_{comp_id}") as C:
        bus = L.wg.strt(length=2*radius+2*coupling_length, width=wg_width).put(0, 0)
        nd.Pin('a0').put(bus.pin['a0'])
        nd.Pin('b0').put(bus.pin['b0'])
        ring = L.wg.bend(radius=radius, angle=180, width=wg_width).put(
            bus.pin['b0'].move(-radius, wg_width+gap))
        pinringb = nd.Pin('rb').put(ring.pin['a0'])
        pinringt = nd.Pin('rt').put(ring.pin['a0'].move(0, -2*radius))
        L.wg.bend(radius=radius, angle=-180, width=wg_width).put(
            bus.pin['b0'].move(-radius-coupling_length, wg_width+gap, -180))
        L.wg.strt(length=coupling_length, width=wg_width).put(pinringb)
        L.wg.strt(length=coupling_length, width=wg_width).put(pinringt)
        _place_graphene_and_vias(L, ring, radius, wg_width, theta, theta1,
                                  via_size, via_gap, layer_spacing,
                                  coupling_length=coupling_length,
                                  pad_size=pad_size, pad_open_factor=pad_open_factor,
                                  pad_distance=pad_distance)
        nd.put_stub()
    return C


# ── Straight EAM ─────────────────────────────────────────────────────────────
def _StraightEAM(comp_id, p):
    wg_width        = float(p["wg_width"])
    gr_length       = float(p["gr_length"])
    gr_width        = float(p["gr_width"])
    wg_extra        = float(p["wg_extra"])
    gm1_offset      = float(p["gm1_offset"])
    pass_overlap    = float(p["pass_overlap"])
    via_size        = float(p.get("via_size", 0.36))
    via_gap         = float(p.get("via_gap", 0.36))
    via_rows        = int(p.get("via_rows", 4))
    via_row_spacing = float(p.get("via_row_spacing", 0.72))
    via_length      = float(p.get("via_length", gr_length))
    via_start_offset= float(p.get("via_start_offset", 0.0))

    ic    = ihp.IC_SiNBWG
    ic_grt= ihp.IC_GRT; ic_grb= ihp.IC_GRB
    ic_gm1= ihp.IC_GM1; ic_gps= ihp.IC_GPS

    with nd.Cell(f"EAM_{comp_id}") as C:
        total  = gr_length + wg_extra
        wg     = ic.strt(length=total, width=wg_width).put()
        nd.Pin("opt_in").put(wg.pin["a0"])
        nd.Pin("opt_out").put(wg.pin["b0"])

        x0     = total/2.0 - gr_length/2.0
        gy_top = -wg_width/2.0 + gr_width/2.0
        gy_bot = +wg_width/2.0 - gr_width/2.0
        ic_grt.strt(length=gr_length, width=gr_width).put(x0, gy_top)
        ic_grb.strt(length=gr_length, width=gr_width).put(x0, gy_bot)

        my_top = gy_top + abs(gm1_offset) + wg_width
        my_bot = gy_bot - abs(gm1_offset) - wg_width
        ic_gm1.strt(length=gr_length, width=gr_width).put(x0, my_top)
        ic_gm1.strt(length=gr_length, width=gr_width).put(x0, my_bot)

        ic_gps.strt(length=gr_length+pass_overlap,
                    width=gr_width+pass_overlap/2).put(x0-pass_overlap/2, gy_bot-pass_overlap/4)

        nd.Pin("m_top_L").put(x0,            my_top, 180)
        nd.Pin("m_top_R").put(x0+gr_length,  my_top,   0)
        nd.Pin("m_bot_L").put(x0,            my_bot, 180)
        nd.Pin("m_bot_R").put(x0+gr_length,  my_bot,   0)

        def put_via_band(center_y, away_sign):
            x_start = x0 + via_start_offset
            pitch_v = via_size + via_gap
            nX_v = max(1, int(np.floor(via_length / pitch_v)))
            for ix in range(nX_v):
                vx = x_start + ix * pitch_v
                for rv in range(via_rows):
                    vy = center_y + away_sign * rv * via_row_spacing
                    nd.Polygon(layer=85, points=[(0,0),(via_size,0),(via_size,via_size),(0,via_size)]).put(vx, vy)

        put_via_band(center_y=gm1_offset + wg_width/2 + via_start_offset, away_sign=1)
        put_via_band(center_y=0 - wg_width/2 - via_size - gm1_offset - via_start_offset, away_sign=-1)

        nd.put_stub()
    return C


def _FreeShape(comp_id, p):
    layer_map = {
        "SiN": ihp.IC_SiNBWG, "GRT": ihp.IC_GRT, "GRB": ihp.IC_GRB,
        "GPS": ihp.IC_GPS,     "GM1": ihp.IC_GM1, "GCT": ihp.IC_GCT,
    }
    lyr_key = p.get("layer", "GM1")
    W = float(p.get("width", 20)); H = float(p.get("height", 10))
    shape = p.get("shape", "rect")
    layer_num_map = {"SiN": 119, "GRT": None, "GRB": None, "GPS": None,
                     "GM1": 109, "GCT": 97, "VIA": 85, "PAD": None}

    with nd.Cell(f"SHAPE_{comp_id}") as C:
        custom_points = p.get("points")
        if custom_points and isinstance(custom_points, list) and len(custom_points) >= 3:
            lnum = layer_num_map.get(lyr_key)
            if lnum:
                nd.Polygon(layer=lnum, points=custom_points).put(0, 0)
            elif lyr_key in layer_map:
                ic_lyr = layer_map[lyr_key]
                ic_lyr.strt(length=W, width=H).put(0, 0)
        elif lyr_key in layer_map:
            ic_lyr = layer_map[lyr_key]
            if shape == "rect":
                ic_lyr.strt(length=W, width=H).put(0, 0)
            elif shape in ("ellipse", "disc"):
                r = min(W, H) / 2
                lnum = layer_num_map.get(lyr_key, 109)
                if lnum:
                    nd.Polygon(layer=lnum, points=geom.circle(radius=r, N=128)).put(W/2, 0)
                else:
                    ic_lyr.strt(length=W, width=H).put(0, 0)
            elif shape == "ring":
                lnum = layer_num_map.get(lyr_key, 109)
                r_outer = min(W, H) / 2
                r_inner = r_outer * float(p.get("inner_ratio", 0.5))
                if lnum:
                    outer = geom.circle(radius=r_outer, N=128)
                    inner = geom.circle(radius=r_inner, N=128)[::-1]
                    nd.Polygon(layer=lnum, points=outer + inner).put(W/2, 0)
            else:
                ic_lyr.strt(length=W, width=H).put(0, 0)
        else:
            try:
                lnum = int(lyr_key)
                nd.Polygon(layer=lnum,
                           points=geom.rectangle(length=W, height=H)).put(0, 0)
            except ValueError:
                pass
        nd.Pin("sh_l").put(0,   0,  180)
        nd.Pin("sh_r").put(W,   0,    0)
        nd.Pin("sh_t").put(W/2, H/2, 90)
        nd.Pin("sh_b").put(W/2, -H/2, -90)
        nd.put_stub()
    return C


def _ArcWG(comp_id, p):
    with nd.Cell(f"ARC_{comp_id}") as C:
        wg = ihp.IC_SiNBWG.bend(
            radius=float(p["radius"]),
            angle=float(p["arc_angle"]),
            width=float(p.get("wg_width", 0.7)),
        ).put()
        nd.Pin("arc_in").put(wg.pin["a0"])
        nd.Pin("arc_out").put(wg.pin["b0"])
        nd.put_stub()
    return C


def _BondPad(comp_id, p):
    pad_length = float(p["pad_length"])
    pad_width  = float(p["pad_width"])
    try:
        return ihp.PAD_Rec(pad_length=pad_length, pad_width=pad_width)
    except Exception:
        open_factor = float(p.get("open_factor", 0.4))
        with nd.Cell(f"PAD_{comp_id}") as C:
            nd.Polygon(layer=109, points=geom.rectangle(length=pad_length, height=pad_width)).put(0, 0)
            il = pad_length * (1.0 - open_factor)
            iw = pad_width  * (1.0 - open_factor)
            nd.Polygon(layer=97, points=geom.rectangle(length=il, height=iw)).put(
                open_factor*pad_length/2, open_factor*pad_width/2)
            nd.Pin("a0").put(0, pad_width/2, 180)
            nd.Pin("b0").put(pad_length, pad_width/2, 0)
            nd.Pin("a1").put(pad_length/2, pad_width, 90)
            nd.Pin("b1").put(pad_length/2, 0, -90)
            nd.put_stub()
        return C


def _MMI(comp_id, p):
    """
    MMI splitter - supports both flat rectangular and tapered (poly) body styles.
    Set 'mmi_style' param to 'flat' or 'poly' (default: 'flat')
    """
    ni = int(p.get('num_inputs', 1))
    no = int(p.get('num_outputs', 2))
    mw = float(p['mmi_width'])      # MMI body width
    ml = float(p['mmi_length'])     # MMI body length
    ww = float(p.get('wg_width', 0.7))  # waveguide width
    style = p.get('mmi_style', 'flat')  # 'flat' or 'poly'
    
    # Calculate input/output port Y positions (centered on MMI)
    oi = [0] if ni == 1 else [(i - (ni-1)/2) * (mw/(ni+1)) for i in range(ni)]
    oo = [0] if no == 1 else [(i - (no-1)/2) * (mw/(no+1)) for i in range(no)]
    
    ic = ihp.IC_SiNBWG
    wg_ext = 10  # waveguide extension length
    
    with nd.Cell(f"MMI_{comp_id}") as C:
        if style == 'poly':
            # Tapered MMI body using MMI_poly
            nd.Polygon(layer=119, points=geom.MMI_poly(wmmi=mw, lmmi=ml, wi=ww, wo=ww, oi=oi, oo=oo)).put(0, 0)
        else:
            # Flat rectangular MMI body
            nd.Polygon(layer=119, points=geom.rectangle(length=ml, height=mw)).put(0, -mw/2)
        
        # Input waveguides (extending from left side of MMI)
        for i, oy in enumerate(oi):
            ic.strt(length=wg_ext, width=ww).put(0, oy, 180)
            nd.Pin(f'a{i}').put(-wg_ext, oy, 180)
        
        # Output waveguides (extending from right side of MMI)
        for i, oy in enumerate(oo):
            ic.strt(length=wg_ext, width=ww).put(ml, oy, 0)
            nd.Pin(f'b{i}').put(ml + wg_ext, oy, 0)
        
        nd.put_stub()
    return C

def _DC(comp_id, p):
    cl=float(p['coupling_length']); gap=float(p['gap']); ww=float(p.get('wg_width',0.7)); sl=float(p.get('straight_length',20))
    tl=cl+sl*2; ic=ihp.IC_SiNBWG; sep=gap+ww
    with nd.Cell(f"DC_{comp_id}") as C:
        ic.strt(length=tl,width=ww).put(0,0)
        ic.strt(length=tl,width=ww).put(0,sep)
        nd.Pin('a0').put(0,0,180); nd.Pin('b0').put(tl,0,0)
        nd.Pin('a1').put(0,sep,180); nd.Pin('b1').put(tl,sep,0)
        nd.put_stub()
    return C

def _PhaseMod(comp_id, p):
    ml=float(p['mod_length']); ww=float(p.get('wg_width',0.7)); ew=float(p.get('electrode_width',10))
    ic=ihp.IC_SiNBWG
    with nd.Cell(f"PM_{comp_id}") as C:
        ic.strt(length=ml,width=ww).put(0,0)
        nd.Polygon(layer=109,points=geom.rectangle(length=ml*0.9,height=ew/2)).put(ml*0.05,ww)
        nd.Polygon(layer=109,points=geom.rectangle(length=ml*0.9,height=ew/2)).put(ml*0.05,-ww-ew/2)
        nd.Pin('opt_in').put(0,0,180); nd.Pin('opt_out').put(ml,0,0)
        nd.Pin('el_top').put(ml/2,ew/2+2,90); nd.Pin('el_bot').put(ml/2,-ew/2-2,-90)
        nd.put_stub()
    return C

def _SSC(comp_id, p):
    tl=float(p['taper_length']); w1=float(p['width_in']); w2=float(p['width_out'])
    ic=ihp.IC_SiNBWG
    with nd.Cell(f"SSC_{comp_id}") as C:
        ic.taper(length=tl,width1=w1,width2=w2).put(0,0)
        nd.Pin('a0').put(0,0,180); nd.Pin('b0').put(tl,0,0)
        nd.put_stub()
    return C

def _YJunction(comp_id, p):
    jl=float(p['junction_length']); ww=float(p.get('wg_width',0.7)); sep=float(p['arm_separation'])
    ic=ihp.IC_SiNBWG
    with nd.Cell(f"YJ_{comp_id}") as C:
        ic.sbend(offset=sep/2,radius=20,width=ww).put(0,0)
        ic.sbend(offset=-sep/2,radius=20,width=ww).put(0,0)
        nd.Pin('a0').put(0,0,180)
        nd.Pin('b0').put(jl,sep/2,0); nd.Pin('b1').put(jl,-sep/2,0)
        nd.put_stub()
    return C

def _MZI(comp_id, p):
    al=float(p['arm_length']); sep=float(p['arm_separation']); ww=float(p.get('wg_width',0.7))
    sl=float(p.get('splitter_length',30)); dl=float(p.get('delta_length',0))
    ic=ihp.IC_SiNBWG
    with nd.Cell(f"MZI_{comp_id}") as C:
        s1t=ic.sbend(offset=sep/2,radius=20,width=ww).put(0,0)
        s1b=ic.sbend(offset=-sep/2,radius=20,width=ww).put(0,0)
        at=ic.strt(length=al,width=ww).put(s1t.pin['b0'])
        ab=ic.strt(length=al+dl,width=ww).put(s1b.pin['b0'])
        ic.sbend(offset=-sep/2,radius=20,width=ww).put(at.pin['b0'])
        ic.sbend(offset=sep/2,radius=20,width=ww).put(ab.pin['b0'])
        nd.Pin('a0').put(0,0,180); nd.Pin('b0').put(sl*2+al+dl,0,0)
        nd.put_stub()
    return C

def _TextLabel(comp_id, p):
    txt=str(p.get('text','LABEL')); th=float(p.get('text_height',50))
    layer_name=p.get('layer','SiNWG')
    PDK_LN={"GraphBot":78,"GraphTop":79,"GraphGate":118,"GraphCont":85,"GraphMetal1":109,"GraphMet1L":110,"SiWG":86,"SiNWG":119,"SiGrating":87,"SiNGrating":88,"GraphPas":89,"GraphPAD":97,"Alignment":234,"SiN":119,"GM1":109}
    ln=PDK_LN.get(layer_name,119)
    return nd.text(text=txt,height=th,layer=ln)

def _GSGPad(comp_id, p):
    pw=float(p.get('pad_width',80)); ph=float(p.get('pad_height',80)); pg=float(p.get('pad_gap',50))
    with nd.Cell(f"GSG_{comp_id}") as C:
        nd.Polygon(layer=109,points=geom.rectangle(length=pw,height=ph)).put(0,0)
        nd.Polygon(layer=109,points=geom.rectangle(length=pw,height=ph)).put(pw+pg,0)
        nd.Polygon(layer=109,points=geom.rectangle(length=pw,height=ph)).put(pw*2+pg*2,0)
        nd.Pin('gnd_l').put(pw/2,ph/2,90)
        nd.Pin('sig').put(pw+pg+pw/2,ph/2,90)
        nd.Pin('gnd_r').put(pw*2+pg*2+pw/2,ph/2,90)
        nd.put_stub()
    return C


def _Spiral(comp_id, p):
    """
    Square spiral delay line - two interleaved square spirals connected at center.
    Based on IHP design pattern with IN and OUT spirals joined by sbend.
    
    PRIMARY PARAMETER:
    - total_length: Target total waveguide length (µm) - the spiral auto-calculates
                    N, L0, and adjusted_length to achieve this length
    
    SECONDARY PARAMETERS:
    - wg_width: Waveguide width (µm)
    - min_radius (R): Bend radius for 90° corners (µm)
    - spacing (spc): Space between adjacent waveguide runs (µm)
    
    The algorithm:
    1. Start with estimated N based on target length
    2. Calculate L0 to fit the spiral geometry
    3. Fine-tune adjusted_length to hit exact target
    """
    import time
    import math
    
    # Primary parameter - target length
    target_length = float(p.get('total_length', 10000))  # Default 10mm = 10000µm
    
    # Secondary parameters
    wg_width = float(p.get('wg_width', 0.7))
    R = float(p.get('min_radius', 100))
    spc = float(p.get('spacing', 10))
    
    ic = ihp.IC_SiNBWG
    space = spc + wg_width
    
    # ============================================================
    # AUTO-CALCULATE N and L0 from target_length
    # ============================================================
    # Each spiral layer contributes approximately:
    #   2 * (L + W) + 4 * (π*R/2)  per layer
    # Both spirals (IN + OUT) double this, plus sbend connection
    #
    # Rough estimate: total_length ≈ 4 * N * avg_segment + bends + sbend
    # Start with N estimate and refine
    
    def estimate_length(N, L0):
        """Estimate total spiral length for given N and L0"""
        W0 = (4*N - 1) * space + 12
        length = 0
        L, W = L0, W0
        bend_length = math.pi * R / 2  # 90° bend arc length
        
        for _ in range(2*N):
            if L <= 0 or W <= 0 or (L + W) <= 4*R:
                break
            length += L + bend_length
            L -= space
            W -= space
            if L <= 0 or W <= 0 or (L + W) <= 4*R:
                break
            length += W + bend_length
            L -= space
            W -= space
        
        # Both spirals are identical
        length *= 2
        # Add sbend connection (approximate)
        length += W0 + 2*R + 100
        return length
    
    def find_optimal_params(target):
        """Find N and L0 that achieve target length"""
        best_N, best_L0, best_diff = 1, 500, float('inf')
        
        # Try different N values
        for N in range(1, 20):
            # For each N, find L0 that gets closest to target
            # Binary search for L0
            L0_min, L0_max = 100, 2000
            
            for _ in range(20):  # Binary search iterations
                L0_mid = (L0_min + L0_max) / 2
                est_len = estimate_length(N, L0_mid)
                
                if est_len < target:
                    L0_min = L0_mid
                else:
                    L0_max = L0_mid
            
            L0 = (L0_min + L0_max) / 2
            est_len = estimate_length(N, L0)
            diff = abs(est_len - target)
            
            if diff < best_diff:
                best_diff = diff
                best_N = N
                best_L0 = L0
        
        return best_N, best_L0
    
    # Find optimal N and L0
    N, L0 = find_optimal_params(target_length)
    
    # Calculate W0 and fine-tune with adjusted_length
    base_W0 = (4*N - 1) * space
    estimated = estimate_length(N, L0)
    
    # Adjust L0 slightly to hit target more precisely
    if estimated != 0:
        scale = target_length / estimated
        L0 = L0 * scale
    
    # Recalculate final values
    W0 = (4*N - 1) * space + 12
    BreakPoint = 4 * R
    
    # Unique trace ID for length calculation
    trace_id = f"spiral_{comp_id}_{time.time()}"
    
    with nd.Cell(f"SPIRAL_{comp_id}") as C:
        nd.trace.trace_start(trace_id)
        
        # ---- Spiral "IN" part (starts at origin, going right) ----
        IN = ic.strt(length=1, width=wg_width).put(0, 0, 0)
        
        L = L0
        W = W0
        b1 = None
        
        for _ in range(2*N):
            if L <= 0 or W <= 0:
                break
            ic.strt(length=max(L, 1), width=wg_width).put()
            b1 = ic.bend(angle=90, radius=R, width=wg_width).put()
            L -= space
            W -= space
            if (L + W <= BreakPoint) or min(L, W) <= 0:
                break
            
            ic.strt(length=max(W, 1), width=wg_width).put()
            b1 = ic.bend(angle=90, radius=R, width=wg_width).put()
            L -= space
            W -= space
            if (L + W <= BreakPoint) or min(L, W) <= 0:
                break
        
        # ---- Spiral "OUT" part (starts offset, interleaved with IN) ----
        L = L0
        W = W0
        OUT = ic.strt(length=1, width=wg_width).put(L0 + spc + 4, W0 + 2*R, 0, flop=True)
        
        b2 = None
        for _ in range(2*N):
            if L <= 0 or W <= 0:
                break
            ic.strt(length=max(L, 1), width=wg_width).put()
            b2 = ic.bend(angle=90, radius=R, width=wg_width).put()
            L -= space
            W -= space
            if (L + W <= BreakPoint) or min(L, W) <= 0:
                break
            
            ic.strt(length=max(W, 1), width=wg_width).put()
            b2 = ic.bend(angle=90, radius=R, width=wg_width).put()
            L -= space
            W -= space
            if (L + W <= BreakPoint) or min(L, W) <= 0:
                break
        
        # Connect the two spiral centers with an S-bend
        if b1 is not None and b2 is not None:
            ic.sbend_p2p(b1, b2, radius=R, width=wg_width, Lstart=100).put()
        
        # Get total traced length
        actual_length = nd.trace.trace_length(trace_id)
        nd.trace.trace_stop()
        
        # Add length annotation text
        nd.text(
            layer=119,
            text=f"Target={round(target_length/1000, 2)}mm Actual={round(actual_length/1000, 2)}mm N={N} W={wg_width}um",
            height=20
        ).put(0, -40)
        
        # Define pins
        nd.Pin('a0').put(IN.pin['a0'])
        nd.Pin('b0').put(OUT.pin['a0'])
        
        nd.put_stub()
    return C


# ── Euler Bend ──────────────────────────────────────────────────────────────
def _EulerBend(comp_id, p):
    """
    Euler bend - clothoid/Cornu spiral bend with zero curvature at ends.
    Provides smooth transition from straight to curved waveguide.
    """
    angle = float(p.get('angle', 90))
    radius = float(p.get('radius', 100))
    wg_width = float(p.get('wg_width', 0.7))
    
    ic = ihp.IC_SiNBWG
    
    with nd.Cell(f"EULER_{comp_id}") as C:
        e = ic.euler(angle=angle, radius=radius, width=wg_width).put(0, 0, 0)
        nd.Pin('a0').put(e.pin['a0'])
        nd.Pin('b0').put(e.pin['b0'])
        nd.put_stub()
    return C


# ── Cobra Curve (P-Curve) ───────────────────────────────────────────────────
def _CobraCurve(comp_id, p):
    """
    Cobra/P-curve - parametric curve that smoothly connects two points.
    Maximizes minimum bend radius along the path.
    """
    end_x = float(p.get('end_x', 200))
    end_y = float(p.get('end_y', 100))
    end_angle = float(p.get('end_angle', 0))
    wg_width = float(p.get('wg_width', 0.7))
    radius1 = float(p.get('radius1', 0))  # 0 = straight at start
    radius2 = float(p.get('radius2', 0))  # 0 = straight at end
    
    ic = ihp.IC_SiNBWG
    
    with nd.Cell(f"COBRA_{comp_id}") as C:
        # Create start and end pins
        start = ic.strt(length=1, width=wg_width).put(0, 0, 0)
        end = ic.strt(length=1, width=wg_width).put(end_x, end_y, end_angle + 180)
        
        # Connect with cobra
        cobra = ic.cobra_p2p(
            pin1=start.pin['b0'],
            pin2=end.pin['a0'],
            radius1=radius1,
            radius2=radius2,
            width1=wg_width,
            width2=wg_width
        ).put()
        
        nd.Pin('a0').put(start.pin['a0'])
        nd.Pin('b0').put(end.pin['b0'])
        nd.put_stub()
    return C


# ── DBR Grating ─────────────────────────────────────────────────────────────
def _DBRGrating(comp_id, p):
    """
    Distributed Bragg Reflector - periodic grating for wavelength filtering.
    """
    period = float(p.get('period', 0.32))
    num_periods = int(p.get('num_periods', 100))
    wg_width = float(p.get('wg_width', 0.7))
    duty_cycle = float(p.get('duty_cycle', 0.5))
    delta_w = float(p.get('delta_w', 0.1))  # Width modulation amplitude
    
    ic = ihp.IC_SiNBWG
    
    with nd.Cell(f"DBR_{comp_id}") as C:
        total_length = period * num_periods
        
        # Create DBR as alternating width sections
        x = 0
        for i in range(num_periods):
            # Wide section
            w1 = wg_width + delta_w
            l1 = period * duty_cycle
            ic.strt(length=l1, width=w1).put(x, 0, 0)
            x += l1
            
            # Narrow section
            w2 = wg_width - delta_w
            l2 = period * (1 - duty_cycle)
            ic.strt(length=l2, width=w2).put(x, 0, 0)
            x += l2
        
        nd.Pin('a0').put(0, 0, 180)
        nd.Pin('b0').put(total_length, 0, 0)
        nd.put_stub()
    return C


# ── Photonic Crystal Array ──────────────────────────────────────────────────
def _PhotonicCrystal(comp_id, p):
    """
    Photonic crystal array - periodic hole pattern.
    """
    rows = int(p.get('rows', 5))
    cols = int(p.get('cols', 10))
    hole_radius = float(p.get('hole_radius', 0.15))
    pitch_x = float(p.get('pitch_x', 0.45))
    pitch_y = float(p.get('pitch_y', 0.45))
    lattice = p.get('lattice', 'square')  # 'square' or 'hexagonal'
    
    layer_name = p.get('layer', 'SiNWG')
    PDK_LN = {"SiNWG": 119, "SiWG": 86, "SiN": 119}
    ln = PDK_LN.get(layer_name, 119)
    
    with nd.Cell(f"PHC_{comp_id}") as C:
        for row in range(rows):
            for col in range(cols):
                if lattice == 'hexagonal':
                    # Hexagonal lattice - offset every other row
                    x = col * pitch_x + (row % 2) * pitch_x / 2
                    y = row * pitch_y * 0.866  # sqrt(3)/2 for hex packing
                else:
                    # Square lattice
                    x = col * pitch_x
                    y = row * pitch_y
                
                # Draw hole as circle
                nd.Polygon(layer=ln, points=geom.circle(radius=hole_radius, N=32)).put(x, y)
        
        total_w = cols * pitch_x
        total_h = rows * pitch_y * (0.866 if lattice == 'hexagonal' else 1)
        
        nd.Pin('a0').put(0, total_h / 2, 180)
        nd.Pin('b0').put(total_w, total_h / 2, 0)
        nd.Pin('center').put(total_w / 2, total_h / 2, 0)
        nd.put_stub()
    return C


# ── Square Array (grid of shapes) ───────────────────────────────────────────
def _SquareArray(comp_id, p):
    """
    Array of squares/rectangles arranged in a grid pattern.
    """
    rows = int(p.get('rows', 5))
    cols = int(p.get('cols', 5))
    element_width = float(p.get('element_width', 10))
    element_height = float(p.get('element_height', 10))
    pitch_x = float(p.get('pitch_x', 20))
    pitch_y = float(p.get('pitch_y', 20))
    
    layer_name = p.get('layer', 'SiNWG')
    PDK_LN = {"SiNWG": 119, "SiWG": 86, "SiN": 119, "GM1": 109, "Alignment": 234}
    ln = PDK_LN.get(layer_name, 119)
    
    with nd.Cell(f"SQARR_{comp_id}") as C:
        for row in range(rows):
            for col in range(cols):
                x = col * pitch_x
                y = row * pitch_y
                # Center each element at grid point
                nd.Polygon(layer=ln, points=geom.rectangle(
                    length=element_width, height=element_height
                )).put(x - element_width/2, y - element_height/2)
        
        total_w = (cols - 1) * pitch_x
        total_h = (rows - 1) * pitch_y
        
        nd.Pin('a0').put(-element_width/2, total_h / 2, 180)
        nd.Pin('b0').put(total_w + element_width/2, total_h / 2, 0)
        nd.Pin('center').put(total_w / 2, total_h / 2, 0)
        nd.put_stub()
    return C


# ── Circular Array (shapes on circumference) ────────────────────────────────
def _CircularArray(comp_id, p):
    """
    Array of shapes arranged on concentric circles.
    Supports multiple layers (rings) with controllable spacing.
    Can specify either num_elements OR arc_spacing (distance between elements along circumference).
    """
    radius = float(p.get('radius', 100))  # inner radius
    num_layers = int(p.get('num_layers', 1))  # number of concentric rings
    layer_spacing = float(p.get('layer_spacing', 20))  # radial spacing between rings
    angular_spacing = float(p.get('angular_spacing', 0))  # extra angular offset per layer (degrees)
    start_angle = float(p.get('start_angle', 0))
    end_angle = float(p.get('end_angle', 360))
    element_width = float(p.get('element_width', 10))
    element_height = float(p.get('element_height', 10))
    element_shape = p.get('element_shape', 'rectangle')  # 'rectangle' or 'circle'
    rotate_elements = p.get('rotate_elements', True)  # rotate to face center
    
    # Spacing mode: either specify num_elements OR arc_spacing
    arc_spacing = float(p.get('arc_spacing', 0))  # distance along circumference between elements (0 = use num_elements)
    num_elements = int(p.get('num_elements', 8))
    
    layer_name = p.get('layer', 'SiNWG')
    PDK_LN = {"SiNWG": 119, "SiWG": 86, "SiN": 119, "GM1": 109, "Alignment": 234}
    ln = PDK_LN.get(layer_name, 119)
    
    with nd.Cell(f"CIRARR_{comp_id}") as C:
        outer_radius = radius + (num_layers - 1) * layer_spacing
        
        for layer_idx in range(num_layers):
            current_radius = radius + layer_idx * layer_spacing
            layer_angle_offset = layer_idx * angular_spacing
            
            # Calculate number of elements for this ring based on arc_spacing or num_elements
            if arc_spacing > 0:
                # Calculate from arc spacing - circumference / spacing
                arc_length = current_radius * (end_angle - start_angle) * np.pi / 180
                ring_num_elements = max(1, int(arc_length / arc_spacing))
            else:
                ring_num_elements = num_elements
            
            # Calculate angle step
            if ring_num_elements > 1:
                if end_angle - start_angle >= 360:
                    angle_step = 360 / ring_num_elements
                else:
                    angle_step = (end_angle - start_angle) / (ring_num_elements - 1)
            else:
                angle_step = 0
            
            for i in range(ring_num_elements):
                angle_deg = start_angle + i * angle_step + layer_angle_offset
                angle_rad = angle_deg * np.pi / 180
                
                x = current_radius * np.cos(angle_rad)
                y = current_radius * np.sin(angle_rad)
                
                if element_shape == 'circle':
                    pts = geom.circle(radius=element_width/2, N=32)
                else:
                    pts = geom.rectangle(length=element_width, height=element_height)
                    # Shift to center
                    pts = [(px - element_width/2, py - element_height/2) for px, py in pts]
                
                if rotate_elements and element_shape != 'circle':
                    # Rotate element to face radially outward
                    rot_rad = angle_rad + np.pi/2
                    cos_r, sin_r = np.cos(rot_rad), np.sin(rot_rad)
                    pts = [(px * cos_r - py * sin_r, px * sin_r + py * cos_r) for px, py in pts]
                
                # Shift to position
                pts = [(px + x, py + y) for px, py in pts]
                nd.Polygon(layer=ln, points=pts).put(0, 0)
        
        nd.Pin('a0').put(-outer_radius - element_width/2, 0, 180)
        nd.Pin('b0').put(outer_radius + element_width/2, 0, 0)
        nd.Pin('center').put(0, 0, 0)
        nd.Pin('top').put(0, outer_radius + element_height/2, 90)
        nd.Pin('bottom').put(0, -outer_radius - element_height/2, -90)
        nd.put_stub()
    return C


# ── Custom Polygon ──────────────────────────────────────────────────────────
def _CustomPolygon(comp_id, p):
    """
    Custom polygon with user-defined vertices.
    Points should be provided as a list of [x, y] coordinates.
    """
    points_str = p.get('points', '[[0,0],[100,0],[100,50],[50,80],[0,50]]')
    
    # Parse points from string if needed
    if isinstance(points_str, str):
        import json
        try:
            points = json.loads(points_str)
        except:
            points = [[0,0], [100,0], [100,50], [50,80], [0,50]]
    else:
        points = points_str
    
    layer_name = p.get('layer', 'SiNWG')
    PDK_LN = {"SiNWG": 119, "SiWG": 86, "SiN": 119, "GM1": 109}
    ln = PDK_LN.get(layer_name, 119)
    
    with nd.Cell(f"POLY_{comp_id}") as C:
        nd.Polygon(layer=ln, points=points).put(0, 0)
        
        # Calculate bounding box for pins
        xs = [pt[0] for pt in points]
        ys = [pt[1] for pt in points]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
        
        nd.Pin('a0').put(min_x, cy, 180)
        nd.Pin('b0').put(max_x, cy, 0)
        nd.Pin('center').put(cx, cy, 0)
        nd.Pin('top').put(cx, max_y, 90)
        nd.Pin('bottom').put(cx, min_y, -90)
        nd.put_stub()
    return C


# ── Sine Bend ───────────────────────────────────────────────────────────────
def _SineBend(comp_id, p):
    """
    Sine bend - S-curve with zero curvature at both ends.
    """
    distance = float(p.get('distance', 100))
    offset = float(p.get('offset', 50))
    wg_width = float(p.get('wg_width', 0.7))
    
    ic = ihp.IC_SiNBWG
    
    with nd.Cell(f"SINE_{comp_id}") as C:
        sb = ic.sinebend(distance=distance, offset=offset, width=wg_width).put(0, 0, 0)
        nd.Pin('a0').put(sb.pin['a0'])
        nd.Pin('b0').put(sb.pin['b0'])
        nd.put_stub()
    return C


# ── Tapered Bend ────────────────────────────────────────────────────────────
def _TaperedBend(comp_id, p):
    """
    Bend with width taper along the curve.
    """
    angle = float(p.get('angle', 90))
    radius = float(p.get('radius', 100))
    width1 = float(p.get('width1', 0.5))
    width2 = float(p.get('width2', 2.0))
    
    ic = ihp.IC_SiNBWG
    
    with nd.Cell(f"TAPBEND_{comp_id}") as C:
        # Use ptaper for parabolic taper into bend
        taper = ic.ptaper(length=radius * abs(angle) * np.pi / 180 * 0.3,
                          width1=width1, width2=width2).put(0, 0, 0)
        bend = ic.bend(angle=angle, radius=radius, width=width2).put()
        
        nd.Pin('a0').put(taper.pin['a0'])
        nd.Pin('b0').put(bend.pin['b0'])
        nd.put_stub()
    return C


# ── Image Layer (reference image for design) ────────────────────────────────
def _ImageLayer(comp_id, p):
    """
    Image layer - places a reference image as a polygon outline.
    The image is converted to polygon vertices for GDS export.
    Note: Actual image display is handled in frontend only.
    """
    width = float(p.get('width', 500))
    height = float(p.get('height', 500))
    layer_name = p.get('layer', 'Alignment')
    
    PDK_LN = {"Alignment": 234, "SiNWG": 119, "Reference": 999}
    ln = PDK_LN.get(layer_name, 234)
    
    with nd.Cell(f"IMG_{comp_id}") as C:
        # Create bounding rectangle for the image reference
        nd.Polygon(layer=ln, points=geom.rectangle(length=width, height=height)).put(0, -height/2)
        
        nd.Pin('a0').put(0, 0, 180)
        nd.Pin('b0').put(width, 0, 0)
        nd.Pin('center').put(width/2, 0, 0)
        nd.put_stub()
    return C


def _GeoShape(comp_id, comp_type, p):
    """
    Build geometric shapes with pins at CENTER OF EDGES to match React canvas.
    
    React canvas pin positions for rectangle:
      - left:   (0, 0)        -> left-center
      - right:  (W, 0)        -> right-center  
      - top:    (W/2, -H/2)   -> top-center
      - bottom: (W/2, H/2)    -> bottom-center
    
    geom.rectangle() creates points at [(0,0), (L,0), (L,H), (0,H)] with origin at bottom-left.
    We need to shift the polygon so that (0,0) is at left-center, i.e., put polygon at (0, -H/2).
    """
    shape = comp_type.replace("geo_", "")
    layer_name = p.get('layer', 'SiNWG')
    PDK_LN = {"GraphBot":78, "GraphTop":79, "GraphGate":118, "GraphCont":85, 
              "GraphMetal1":109, "GraphMet1L":110, "SiWG":86, "SiNWG":119, 
              "SiGrating":87, "SiNGrating":88, "GraphPas":89, "GraphPAD":97, 
              "Alignment":234, "SiN":119, "GM1":109}
    ln = PDK_LN.get(layer_name, 119)
    
    with nd.Cell(f"SHAPE_{comp_id}") as C:
        if shape == "rectangle":
            L = float(p['length'])
            H = float(p['height'])
            # geom.rectangle creates points at [(0,0), (L,0), (L,H), (0,H)]
            # GDS Y-up coords: we want left-center at origin
            # Place polygon so its center-left is at (0,0)
            nd.Polygon(layer=ln, points=geom.rectangle(length=L, height=H)).put(0, -H/2)
            
            # Pin positions in GDS coordinates (Y-up):
            # React 'left' (dx=0, dy=0) -> GDS (0, 0)
            # React 'right' (dx=L, dy=0) -> GDS (L, 0)
            # React 'top' (dx=L/2, dy=-H/2) -> GDS (L/2, H/2) because Y is flipped
            # React 'bottom' (dx=L/2, dy=H/2) -> GDS (L/2, -H/2) because Y is flipped
            nd.Pin('left').put(0, 0, 180)
            nd.Pin('right').put(L, 0, 0)
            nd.Pin('top').put(L/2, H/2, 90)
            nd.Pin('bottom').put(L/2, -H/2, -90)
            # Also add a0/b0 aliases for compatibility
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(L, 0, 0)
            
        elif shape == "circle":
            r = float(p['radius'])
            # Circle is centered at origin by geom.circle
            nd.Polygon(layer=ln, points=geom.circle(radius=r, N=100)).put(0, 0)
            nd.Pin('center').put(0, 0, 0)
            nd.Pin('left').put(-r, 0, 180)
            nd.Pin('right').put(r, 0, 0)
            nd.Pin('top').put(0, r, 90)
            nd.Pin('bottom').put(0, -r, -90)
            nd.Pin('a0').put(-r, 0, 180)
            nd.Pin('b0').put(r, 0, 0)
            
        elif shape == "ring":
            r = float(p['radius'])
            w = float(p['width'])
            nd.Polygon(layer=ln, points=geom.ring(radius=r, width=w, N=100)).put(0, 0)
            nd.Pin('center').put(0, 0, 0)
            nd.Pin('left').put(-r, 0, 180)
            nd.Pin('right').put(r, 0, 0)
            nd.Pin('a0').put(-r, 0, 180)
            nd.Pin('b0').put(r, 0, 0)
            
        elif shape == "arc":
            r = float(p['radius'])
            w = float(p['width'])
            ang = float(p['angle'])
            nd.Polygon(layer=ln, points=geom.arc(radius=r, width=w, angle=ang, N=100)).put(0, 0)
            rad = ang * np.pi / 180
            nd.Pin('a0').put(r, 0, 0)
            nd.Pin('b0').put(r * np.cos(rad), r * np.sin(rad), ang)
            nd.Pin('center').put(0, 0, 0)
            
        elif shape == "taper":
            L = float(p['length'])
            w1 = float(p['width1'])
            w2 = float(p['width2'])
            # geom.taper is centered vertically
            nd.Polygon(layer=ln, points=geom.taper(length=L, width1=w1, width2=w2)).put(0, 0)
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(L, 0, 0)
            
        elif shape == "trapezoid":
            L = float(p['length'])
            H = float(p['height'])
            a1 = float(p['angle1'])
            a2 = float(p['angle2'])
            nd.Polygon(layer=ln, points=geom.trapezoid(length=L, height=H, angle1=a1, angle2=a2)).put(0, -H/2)
            nd.Pin('left').put(0, 0, 180)
            nd.Pin('right').put(L, 0, 0)
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(L, 0, 0)
            
        elif shape == "parallelogram":
            L = float(p['length'])
            H = float(p['height'])
            ang = float(p['angle'])
            nd.Polygon(layer=ln, points=geom.parallelogram(length=L, height=H, angle=ang)).put(0, -H/2)
            nd.Pin('left').put(0, 0, 180)
            nd.Pin('right').put(L, 0, 0)
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(L, 0, 0)
            
        elif shape == "rhombus":
            L = float(p['length'])
            ang = float(p['angle'])
            nd.Polygon(layer=ln, points=geom.rhombus(length=L, angle=ang)).put(0, 0)
            nd.Pin('left').put(0, 0, 180)
            nd.Pin('right').put(L, 0, 0)
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(L, 0, 0)
            
        elif shape == "rounded_rect":
            L = float(p['length'])
            H = float(p['height'])
            shrink = float(p.get('shrink', 0.2))
            nd.Polygon(layer=ln, points=geom.rounded_rect(length=L, height=H, shrink=shrink)).put(0, -H/2)
            nd.Pin('left').put(0, 0, 180)
            nd.Pin('right').put(L, 0, 0)
            nd.Pin('top').put(L/2, H/2, 90)
            nd.Pin('bottom').put(L/2, -H/2, -90)
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(L, 0, 0)
            
        elif shape == "frame":
            fw = float(p['frame_width'])
            fl = float(p['frame_length'])
            fh = float(p['frame_height'])
            nd.Polygon(layer=ln, points=geom.frame(sizew=fw, sizel=fl, sizeh=fh)).put(0, -fh/2)
            nd.Pin('left').put(0, 0, 180)
            nd.Pin('right').put(fl, 0, 0)
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(fl, 0, 0)
            
        elif shape == "pie":
            r = float(p['radius'])
            ang = float(p['angle'])
            nd.Polygon(layer=ln, points=geom.pie(radius=r, angle=ang, N=100)).put(0, 0)
            nd.Pin('center').put(0, 0, 0)
            nd.Pin('a0').put(0, 0, 180)
            
        elif shape == "tetragon":
            L = float(p['length'])
            H = float(p['height'])
            dx = float(p['dx'])
            x_top = float(p.get('x_top', 0))
            nd.Polygon(layer=ln, points=geom.tetragon(length=L, height=H, dx=dx, x=x_top)).put(0, -H/2)
            nd.Pin('left').put(0, 0, 180)
            nd.Pin('right').put(L, 0, 0)
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(L, 0, 0)
            
        nd.put_stub()
    return C


# ── Arc Trapezoid (curved trapezoid with arc edges) ─────────────────────────
def _ArcTrapezoid(comp_id, p):
    """
    Curved trapezoid with controllable inner/outer widths.
    """
    outer_r = float(p.get('outer_radius', 100))
    inner_r = float(p.get('inner_radius', 50))
    angle = float(p.get('angle', 90))
    outer_width = float(p.get('outer_width', 10))
    inner_width = float(p.get('inner_width', 5))
    inner_style = p.get('inner_style', 'arc')
    
    layer_name = p.get('layer', 'SiNWG')
    PDK_LN = {"SiNWG": 119, "SiWG": 86, "SiN": 119, "GM1": 109, "Alignment": 234}
    ln = PDK_LN.get(layer_name, 119)
    
    N = max(int(abs(angle) / 2), 10)
    
    outer_r_out = outer_r + outer_width / 2
    inner_r_out = inner_r + inner_width / 2 if inner_r > 0 else 0
    
    with nd.Cell(f"ARCTRAP_{comp_id}") as C:
        pts = []
        
        # Outer arc (0 to angle)
        for i in range(N + 1):
            a = (angle * i / N) * np.pi / 180
            pts.append((outer_r_out * np.cos(a), outer_r_out * np.sin(a)))
        
        # Inner edge (angle back to 0)
        if inner_style == 'flat' or inner_r <= 0:
            if inner_r > 0:
                end_ang = angle * np.pi / 180
                pts.append((inner_r_out * np.cos(end_ang), inner_r_out * np.sin(end_ang)))
                pts.append((inner_r_out, 0))
            else:
                pts.append((0, 0))
        else:
            for i in range(N, -1, -1):
                a = (angle * i / N) * np.pi / 180
                pts.append((inner_r_out * np.cos(a), inner_r_out * np.sin(a)))
        
        nd.Polygon(layer=ln, points=pts).put(0, 0)
        
        rad = angle * np.pi / 180
        mid_r = (outer_r + inner_r) / 2
        nd.Pin('a0').put(mid_r, 0, 0)
        nd.Pin('b0').put(mid_r * np.cos(rad), mid_r * np.sin(rad), angle)
        nd.Pin('center').put(0, 0, 0)
        nd.put_stub()
    return C


# ── Imported GDS (polygons from imported file) ────────────────────────────────
def _ImportedGDS(comp_id, p):
    """
    Recreate polygons from an imported GDS file.
    The polygons are stored in params['all_polygons'] as a list of {layer, points}.
    Smart pin placement: finds narrow waveguide endpoints on SiNWG layer.
    Normalizes coordinates so a0 pin is at the narrow waveguide end.
    """
    all_polygons = p.get('all_polygons', [])
    original_name = p.get('original_name', 'imported')
    
    # If no polygons, create an empty cell with just pins
    if not all_polygons:
        cell_name = f"IMP_{comp_id}_empty"
        with nd.Cell(cell_name) as C:
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(10, 0, 0)
            nd.put_stub()
        return C
    
    # Clean name for cell
    cell_name = f"IMP_{comp_id}_{original_name[:20]}"
    cell_name = cell_name.replace(' ', '_').replace('-', '_')
    
    # First pass: calculate bbox and find waveguide polygons
    minX, minY, maxX, maxY = float('inf'), float('inf'), float('-inf'), float('-inf')
    wg_polys = []  # All SiNWG polygons with their bounds
    
    for poly_data in all_polygons:
        layer = int(poly_data.get('layer', 119))
        points = poly_data.get('points', [])
        
        if not points:
            continue
        
        poly_minX, poly_maxX = float('inf'), float('-inf')
        poly_minY, poly_maxY = float('inf'), float('-inf')
        for pt in points:
            x, y = pt[0], pt[1]
            minX = min(minX, x)
            minY = min(minY, y)
            maxX = max(maxX, x)
            maxY = max(maxY, y)
            poly_minX = min(poly_minX, x)
            poly_maxX = max(poly_maxX, x)
            poly_minY = min(poly_minY, y)
            poly_maxY = max(poly_maxY, y)
        
        if layer == 119:  # SiNWG
            height = poly_maxY - poly_minY
            wg_polys.append({
                'minX': poly_minX, 'maxX': poly_maxX,
                'minY': poly_minY, 'maxY': poly_maxY,
                'height': height
            })
    
    # Handle case where no valid polygons were found
    if minX == float('inf'):
        with nd.Cell(cell_name) as C:
            nd.Pin('a0').put(0, 0, 180)
            nd.Pin('b0').put(10, 0, 0)
            nd.put_stub()
        return C
    
    # Find the NARROWEST waveguide polygon (actual waveguide, not taper)
    # Typical waveguide width is 0.5-1.5 µm
    narrow_wg_threshold = 2.0  # µm - consider anything narrower than this as waveguide
    
    # Find narrow waveguides at left and right edges
    left_pin_x = minX
    left_pin_y = (minY + maxY) / 2 if minY != float('inf') else 0
    right_pin_x = maxX
    right_pin_y = left_pin_y
    
    # Sort waveguide polys by height (narrowest first)
    narrow_wgs = [wg for wg in wg_polys if wg['height'] < narrow_wg_threshold]
    
    if narrow_wgs:
        # Find the leftmost narrow waveguide
        leftmost_narrow = min(narrow_wgs, key=lambda w: w['minX'])
        left_pin_x = leftmost_narrow['minX']
        left_pin_y = (leftmost_narrow['minY'] + leftmost_narrow['maxY']) / 2
        
        # Find the rightmost narrow waveguide
        rightmost_narrow = max(narrow_wgs, key=lambda w: w['maxX'])
        right_pin_x = rightmost_narrow['maxX']
        right_pin_y = (rightmost_narrow['minY'] + rightmost_narrow['maxY']) / 2
    
    # Offset to normalize: move so that a0 pin is at origin
    offset_x = -left_pin_x
    offset_y = -left_pin_y
    
    with nd.Cell(cell_name) as C:
        # Create polygons with normalized coordinates
        for poly_data in all_polygons:
            layer = int(poly_data.get('layer', 119))
            points = poly_data.get('points', [])
            
            if not points:
                continue
            
            # Shift coordinates so a0 is at origin
            shifted_points = [(pt[0] + offset_x, pt[1] + offset_y) for pt in points]
            nd.Polygon(layer=layer, points=shifted_points).put(0, 0)
        
        # Place pins - a0 is now at origin (narrow waveguide end)
        nd.Pin('a0').put(0, 0, 180)
        nd.Pin('b0').put(right_pin_x - left_pin_x, right_pin_y - left_pin_y, 0)
        
        nd.put_stub()
    return C


def build_cell(comp_id, comp_type, params):
    if not NAZCA_AVAILABLE:
        raise RuntimeError("nazca/IHP_PDK not installed.")
    if comp_type == "grating_coupler":    return _GratingCoupler(comp_id, params)
    if comp_type == "straight_eam":       return _StraightEAM(comp_id, params)
    if comp_type == "ring_resonator":     return _RingModulator(comp_id, params)
    if comp_type == "racetrack_resonator":return _RacetrackModulator(comp_id, params)
    if comp_type == "ring_no_pad":        return _RingModulator(comp_id, {**params, "pad_size": 0})
    if comp_type == "arc_waveguide":      return _ArcWG(comp_id, params)
    if comp_type == "free_shape":         return _FreeShape(comp_id, params)
    if comp_type == "bond_pad":           return _BondPad(comp_id, params)
    if comp_type == "mmi_splitter":       return _MMI(comp_id, params)
    if comp_type == "mmi_splitter_poly":  return _MMI(comp_id, {**params, "mmi_style": "poly"})
    if comp_type == "directional_coupler":return _DC(comp_id, params)
    if comp_type == "phase_modulator":    return _PhaseMod(comp_id, params)
    if comp_type == "ssc":                return _SSC(comp_id, params)
    if comp_type == "y_junction":         return _YJunction(comp_id, params)
    if comp_type == "mzi":                return _MZI(comp_id, params)
    if comp_type == "text_label":         return _TextLabel(comp_id, params)
    if comp_type == "gsg_pad":            return _GSGPad(comp_id, params)
    if comp_type == "spiral_delay":       return _Spiral(comp_id, params)
    # New components
    if comp_type == "euler_bend":         return _EulerBend(comp_id, params)
    if comp_type == "cobra_curve":        return _CobraCurve(comp_id, params)
    if comp_type == "dbr_grating":        return _DBRGrating(comp_id, params)
    if comp_type == "photonic_crystal":   return _PhotonicCrystal(comp_id, params)
    if comp_type == "square_array":       return _SquareArray(comp_id, params)
    if comp_type == "circular_array":     return _CircularArray(comp_id, params)
    if comp_type == "arc_trapezoid":      return _ArcTrapezoid(comp_id, params)
    if comp_type == "custom_polygon":     return _CustomPolygon(comp_id, params)
    if comp_type == "sine_bend":          return _SineBend(comp_id, params)
    if comp_type == "tapered_bend":       return _TaperedBend(comp_id, params)
    if comp_type == "image_layer":        return _ImageLayer(comp_id, params)
    if comp_type == "imported_gds":       return _ImportedGDS(comp_id, params)
    if comp_type.startswith("geo_"):      return _GeoShape(comp_id, comp_type, params)
    
    # Handle custom building blocks (saved components) - they use imported_gds logic
    if params.get('all_polygons'):
        return _ImportedGDS(comp_id, params)
    
    # If we reach here, create a placeholder empty cell
    print(f"[WARN] Unknown component type: {comp_type}, creating placeholder cell")
    with nd.Cell(f"UNKNOWN_{comp_id}") as C:
        nd.Pin('a0').put(0, 0, 180)
        nd.Pin('b0').put(10, 0, 0)
        nd.put_stub()
    return C


# ═════════════════════════════════════════════════════════════════════════════
#  CODE GENERATION  (FULLY SELF-CONTAINED — no photonic_lib!)
# ═════════════════════════════════════════════════════════════════════════════

# FIXED: No photonic_lib import — scripts are fully self-contained
PREAMBLE = """\
# Auto-generated by Photonic Designer
# This script is FULLY SELF-CONTAINED — only nazca + IHP_PDK needed
# -*- coding: utf-8 -*-
import nazca as nd
import nazca.geometries as geom
import numpy as np
import IHP_PDK as ihp

ic  = ihp.IC_SiNBWG
grt = ihp.IC_GRT;  grb = ihp.IC_GRB
gps = ihp.IC_GPS;  gm1 = ihp.IC_GM1;  gct = ihp.IC_GCT

"""


def _vname(c):
    t = {"grating_coupler":"GC","straight_eam":"EAM","ring_resonator":"Ring",
         "ring_no_pad":"RingNP","racetrack_resonator":"RT",
         "arc_waveguide":"ARC","free_shape":"SHAPE","bond_pad":"PAD",
         "geo_rectangle":"RECT","geo_circle":"CIRC","geo_ring":"RING",
         "geo_arc":"ARC","geo_taper":"TAPER","geo_trapezoid":"TRAP",
         "geo_parallelogram":"PGRAM","geo_rhombus":"RHOMB",
         "geo_rounded_rect":"RRECT","geo_frame":"FRAME",
         "geo_pie":"PIE","geo_tetragon":"TETRA",
         "mmi_splitter":"MMI","directional_coupler":"DC","phase_modulator":"PM",
         "ssc":"SSC","y_junction":"YJ","mzi":"MZI",
         "text_label":"TXT","gsg_pad":"GSG","spiral_delay":"SPIRAL",
         "euler_bend":"EULER","cobra_curve":"COBRA","sine_bend":"SINE",
         "tapered_bend":"TAPBEND","dbr_grating":"DBR","photonic_crystal":"PHC",
         "square_array":"SQARR","circular_array":"CIRARR","arc_trapezoid":"ARCTRAP",
         "custom_polygon":"POLY","image_layer":"IMG"}
    return f"{t.get(c['type'],'X')}_{c['id']}"


@app.route("/api/status", methods=["GET"])
def status():
    return jsonify({"ok": True, "nazca_available": NAZCA_AVAILABLE, "python": sys.version})


@app.route("/api/generate_code", methods=["POST"])
def generate_code():
    data = request.get_json()
    if not data:
        return jsonify({"code": "# Error: no data received.\n"}), 400
    components  = data.get("components", [])
    connections = data.get("connections", [])
    if not components:
        return jsonify({"code": "# No components placed yet.\n"})

    lines = [PREAMBLE]
    comp_map = {c["id"]: c for c in components}

    for c in components:
        cid, ct, p = c["id"], c["type"], c["params"]
        v = _vname(c)

        if ct == "grating_coupler":
            # FIXED: Use ihp.GratingCoupler directly (no plib)
            lines.append(f"# ── Grating Coupler {cid}")
            lines.append(f"{v} = ihp.GratingCoupler(period={p['period']}, tp_width={p.get('tp_width',10)},")
            lines.append(f"    tw={p.get('wg_width',0.7)}, ff={p['ff']}, tp_length={p.get('taper_len',250)})")
            lines.append("")

        elif ct == "straight_eam":
            # FIXED: Inline nd.Cell() block instead of plib
            lines.append(f"# ── Straight EAM {cid}")
            lines.append(f"with nd.Cell('EAM_{cid}') as {v}:")
            lines.append(f"    _ww={p['wg_width']}; _gl={p['gr_length']}; _gw={p['gr_width']}")
            lines.append(f"    _we={p['wg_extra']}; _go={p['gm1_offset']}; _po={p['pass_overlap']}")
            lines.append(f"    _total = _gl + _we")
            lines.append(f"    wg = ic.strt(length=_total, width=_ww).put()")
            lines.append(f"    nd.Pin('opt_in').put(wg.pin['a0'])")
            lines.append(f"    nd.Pin('opt_out').put(wg.pin['b0'])")
            lines.append(f"    _x0 = _total/2 - _gl/2")
            lines.append(f"    _gy_top = -_ww/2 + _gw/2")
            lines.append(f"    _gy_bot = +_ww/2 - _gw/2")
            lines.append(f"    grt.strt(length=_gl, width=_gw).put(_x0, _gy_top)")
            lines.append(f"    grb.strt(length=_gl, width=_gw).put(_x0, _gy_bot)")
            lines.append(f"    _my_top = _gy_top + abs(_go) + _ww")
            lines.append(f"    _my_bot = _gy_bot - abs(_go) - _ww")
            lines.append(f"    gm1.strt(length=_gl, width=_gw).put(_x0, _my_top)")
            lines.append(f"    gm1.strt(length=_gl, width=_gw).put(_x0, _my_bot)")
            lines.append(f"    gps.strt(length=_gl+_po, width=_gw+_po/2).put(_x0-_po/2, _gy_bot-_po/4)")
            lines.append(f"    nd.Pin('m_top_L').put(_x0, _my_top, 180)")
            lines.append(f"    nd.Pin('m_top_R').put(_x0+_gl, _my_top, 0)")
            lines.append(f"    nd.Pin('m_bot_L').put(_x0, _my_bot, 180)")
            lines.append(f"    nd.Pin('m_bot_R').put(_x0+_gl, _my_bot, 0)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "ring_resonator":
            # FIXED: Inline nd.Cell() block
            lines.append(f"# ── Ring Modulator {cid}")
            lines.append(f"with nd.Cell('Ring_{cid}') as {v}:")
            lines.append(f"    _r={p['radius']}; _gap={p['gap']}; _ww={p.get('wg_width',0.7)}")
            lines.append(f"    bus = ic.strt(length=2*_r, width=_ww).put(0, 0)")
            lines.append(f"    nd.Pin('a0').put(bus.pin['a0'])")
            lines.append(f"    nd.Pin('b0').put(bus.pin['b0'])")
            lines.append(f"    ring = ic.bend(radius=_r, angle=360, width=_ww).put(bus.pin['b0'].move(-_r, _ww+_gap))")
            lines.append(f"    # Graphene layers and vias omitted for brevity — full version in backend")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "ring_no_pad":
            lines.append(f"# ── Ring (no pad) {cid}")
            lines.append(f"with nd.Cell('RingNP_{cid}') as {v}:")
            lines.append(f"    _r={p['radius']}; _gap={p['gap']}; _ww={p.get('wg_width',0.7)}")
            lines.append(f"    bus = ic.strt(length=2*_r, width=_ww).put(0, 0)")
            lines.append(f"    nd.Pin('a0').put(bus.pin['a0'])")
            lines.append(f"    nd.Pin('b0').put(bus.pin['b0'])")
            lines.append(f"    ring = ic.bend(radius=_r, angle=360, width=_ww).put(bus.pin['b0'].move(-_r, _ww+_gap))")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "free_shape":
            lines.append(f"# ── Free Shape {cid}")
            lines.append(f"with nd.Cell('SHAPE_{cid}') as {v}:")
            custom_pts = p.get("points")
            if custom_pts and isinstance(custom_pts, list) and len(custom_pts) >= 3:
                lines.append(f"    nd.Polygon(layer={{'GM1':109,'GCT':97,'VIA':85}}.get('{p.get('layer','GM1')}',109),")
                lines.append(f"        points={custom_pts}).put(0,0)")
            else:
                lines.append(f"    nd.Polygon(layer={{'GM1':109,'GCT':97,'VIA':85}}.get('{p.get('layer','GM1')}',109),")
                lines.append(f"        points=geom.rectangle(length={p.get('width',20)},height={p.get('height',10)})).put(0,0)")
            lines.append(f"    nd.Pin('sh_l').put(0,0,180); nd.Pin('sh_r').put({p.get('width',20)},0,0)")
            lines.append(f"    nd.Pin('sh_t').put({p.get('width',20)/2},{p.get('height',10)/2},90)")
            lines.append(f"    nd.Pin('sh_b').put({p.get('width',20)/2},-{p.get('height',10)/2},-90)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "racetrack_resonator":
            lines.append(f"# ── Racetrack {cid}")
            lines.append(f"with nd.Cell('RT_{cid}') as {v}:")
            lines.append(f"    _r={p['radius']}; _gap={p['gap']}; _ww={p.get('wg_width',0.7)}; _cl={p.get('coupling_length',10)}")
            lines.append(f"    bus = ic.strt(length=2*_r+2*_cl, width=_ww).put(0, 0)")
            lines.append(f"    nd.Pin('a0').put(bus.pin['a0'])")
            lines.append(f"    nd.Pin('b0').put(bus.pin['b0'])")
            lines.append(f"    ring = ic.bend(radius=_r, angle=180, width=_ww).put(bus.pin['b0'].move(-_r, _ww+_gap))")
            lines.append(f"    ic.bend(radius=_r, angle=-180, width=_ww).put(bus.pin['b0'].move(-_r-_cl, _ww+_gap, -180))")
            lines.append(f"    ic.strt(length=_cl, width=_ww).put(ring.pin['a0'])")
            lines.append(f"    ic.strt(length=_cl, width=_ww).put(ring.pin['a0'].move(0, -2*_r))")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "arc_waveguide":
            lines.append(f"# ── Arc WG {cid}")
            lines.append(f"with nd.Cell('ARC_{cid}') as {v}:")
            lines.append(f"    wg=ic.bend(radius={p['radius']},angle={p['arc_angle']},width={p.get('wg_width',0.7)}).put()")
            lines.append(f"    nd.Pin('arc_in').put(wg.pin['a0']); nd.Pin('arc_out').put(wg.pin['b0'])")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "bond_pad":
            lines.append(f"# ── Bond Pad {cid}")
            lines.append(f"{v} = ihp.PAD_Rec(pad_length={p['pad_length']},pad_width={p['pad_width']})")
            lines.append("")

        elif ct.startswith("geo_"):
            shape = ct.replace("geo_", "")
            layer_name = p.get("layer", "SiNWG")
            PDK_LAYER_NUM = {"GraphBot":78,"GraphTop":79,"GraphGate":118,"GraphCont":85,
                "GraphMetal1":109,"GraphMet1L":110,"SiWG":86,"SiNWG":119,
                "SiGrating":87,"SiNGrating":88,"GraphPas":89,"GraphPAD":97,"Alignment":234,
                "SiN":119,"GM1":109}
            layer_num = PDK_LAYER_NUM.get(layer_name, 119)
            lines.append(f"# ── Geometry: {shape} {cid} (layer={layer_name}/{layer_num})")
            lines.append(f"with nd.Cell('SHAPE_{cid}') as {v}:")
            if shape == "rectangle":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.rectangle(length={p['length']},height={p['height']})).put(0,0)")
            elif shape == "circle":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.circle(radius={p['radius']},N=100)).put(0,0)")
            elif shape == "ring":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.ring(radius={p['radius']},width={p['width']},N=100)).put(0,0)")
            elif shape == "arc":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.arc(radius={p['radius']},width={p['width']},angle={p['angle']},N=100)).put(0,0)")
            elif shape == "taper":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.taper(length={p['length']},width1={p['width1']},width2={p['width2']})).put(0,0)")
            elif shape == "trapezoid":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.trapezoid(length={p['length']},height={p['height']},angle1={p['angle1']},angle2={p['angle2']})).put(0,0)")
            elif shape == "parallelogram":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.parallelogram(length={p['length']},height={p['height']},angle={p['angle']})).put(0,0)")
            elif shape == "rhombus":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.rhombus(length={p['length']},angle={p['angle']})).put(0,0)")
            elif shape == "rounded_rect":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.rounded_rect(length={p['length']},height={p['height']},shrink={p.get('shrink',0.2)})).put(0,0)")
            elif shape == "frame":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.frame(sizew={p['frame_width']},sizel={p['frame_length']},sizeh={p['frame_height']})).put(0,0)")
            elif shape == "pie":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.pie(radius={p['radius']},angle={p['angle']},N=100)).put(0,0)")
            elif shape == "tetragon":
                lines.append(f"    nd.Polygon(layer={layer_num},points=geom.tetragon(length={p['length']},height={p['height']},dx={p['dx']},x={p.get('x_top',0)})).put(0,0)")
            lines.append(f"    nd.Pin('a0').put(0,0,180)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "mmi_splitter":
            ni=int(p.get('num_inputs',1)); no=int(p.get('num_outputs',2))
            mw=float(p['mmi_width']); ml=float(p['mmi_length']); ww=float(p.get('wg_width',0.7))
            lines.append(f"# ── MMI {ni}×{no} {cid}")
            lines.append(f"with nd.Cell('MMI_{cid}') as {v}:")
            oi_list=[0] if ni==1 else [(i-(ni-1)/2)*(mw/(ni+1)) for i in range(ni)]
            oo_list=[0] if no==1 else [(i-(no-1)/2)*(mw/(no+1)) for i in range(no)]
            lines.append(f"    _oi={oi_list}")
            lines.append(f"    _oo={oo_list}")
            lines.append(f"    nd.Polygon(layer=119, points=geom.MMI_poly(wmmi={mw},lmmi={ml},wi={ww},wo={ww},oi=_oi,oo=_oo)).put(0,0)")
            for i,oy in enumerate(oi_list):
                lines.append(f"    ic.strt(length=10,width={ww}).put(0,{oy:.3f},180)")
            for i,oy in enumerate(oo_list):
                lines.append(f"    ic.strt(length=10,width={ww}).put({ml},{oy:.3f},0)")
            for i,oy in enumerate(oi_list):
                lines.append(f"    nd.Pin('a{i}').put(-10,{oy:.3f},180)")
            for i,oy in enumerate(oo_list):
                lines.append(f"    nd.Pin('b{i}').put({ml+10},{oy:.3f},0)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "directional_coupler":
            lines.append(f"# ── Directional Coupler {cid}")
            cl=p['coupling_length']; gap=p['gap']; ww=p.get('wg_width',0.7); sl=p.get('straight_length',20)
            lines.append(f"with nd.Cell('DC_{cid}') as {v}:")
            lines.append(f"    _tl={cl}+{sl}*2")
            lines.append(f"    ic.strt(length=_tl,width={ww}).put(0,0)")
            lines.append(f"    ic.strt(length=_tl,width={ww}).put(0,{float(gap)+float(ww)})")
            lines.append(f"    nd.Pin('a0').put(0,0,180)")
            lines.append(f"    nd.Pin('b0').put(_tl,0,0)")
            lines.append(f"    nd.Pin('a1').put(0,{float(gap)+float(ww)},180)")
            lines.append(f"    nd.Pin('b1').put(_tl,{float(gap)+float(ww)},0)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "phase_modulator":
            lines.append(f"# ── Phase Modulator {cid}")
            lines.append(f"with nd.Cell('PM_{cid}') as {v}:")
            lines.append(f"    ic.strt(length={p['mod_length']},width={p.get('wg_width',0.7)}).put(0,0)")
            lines.append(f"    _ew={p.get('electrode_width',10)}")
            lines.append(f"    nd.Polygon(layer=109,points=geom.rectangle(length={float(p['mod_length'])*0.9},height=_ew/2)).put({float(p['mod_length'])*0.05},_ew/4)")
            lines.append(f"    nd.Polygon(layer=109,points=geom.rectangle(length={float(p['mod_length'])*0.9},height=_ew/2)).put({float(p['mod_length'])*0.05},-_ew/4-_ew/2)")
            lines.append(f"    nd.Pin('opt_in').put(0,0,180)")
            lines.append(f"    nd.Pin('opt_out').put({p['mod_length']},0,0)")
            lines.append(f"    nd.Pin('el_top').put({float(p['mod_length'])/2},{float(p.get('electrode_width',10))/2+2},90)")
            lines.append(f"    nd.Pin('el_bot').put({float(p['mod_length'])/2},-{float(p.get('electrode_width',10))/2+2},-90)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "ssc":
            lines.append(f"# ── Spot Size Converter {cid}")
            lines.append(f"with nd.Cell('SSC_{cid}') as {v}:")
            lines.append(f"    ic.taper(length={p['taper_length']},width1={p['width_in']},width2={p['width_out']}).put(0,0)")
            lines.append(f"    nd.Pin('a0').put(0,0,180)")
            lines.append(f"    nd.Pin('b0').put({p['taper_length']},0,0)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "y_junction":
            lines.append(f"# ── Y-junction {cid}")
            jl=p['junction_length']; sep=p['arm_separation']; ww=p.get('wg_width',0.7)
            lines.append(f"with nd.Cell('YJ_{cid}') as {v}:")
            lines.append(f"    ic.sbend(offset={float(sep)/2},radius=20,width={ww}).put(0,0)")
            lines.append(f"    ic.sbend(offset=-{float(sep)/2},radius=20,width={ww}).put(0,0)")
            lines.append(f"    nd.Pin('a0').put(0,0,180)")
            lines.append(f"    nd.Pin('b0').put({jl},{float(sep)/2},0)")
            lines.append(f"    nd.Pin('b1').put({jl},-{float(sep)/2},0)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "mzi":
            lines.append(f"# ── Mach-Zehnder Interferometer {cid}")
            al=p['arm_length']; sep=p['arm_separation']; ww=p.get('wg_width',0.7); sl=p.get('splitter_length',30); dl=p.get('delta_length',0)
            lines.append(f"with nd.Cell('MZI_{cid}') as {v}:")
            lines.append(f"    _s1t=ic.sbend(offset={float(sep)/2},radius=20,width={ww}).put(0,0)")
            lines.append(f"    _s1b=ic.sbend(offset=-{float(sep)/2},radius=20,width={ww}).put(0,0)")
            lines.append(f"    _at=ic.strt(length={al},width={ww}).put(_s1t.pin['b0'])")
            lines.append(f"    _ab=ic.strt(length={float(al)+float(dl)},width={ww}).put(_s1b.pin['b0'])")
            lines.append(f"    ic.sbend(offset=-{float(sep)/2},radius=20,width={ww}).put(_at.pin['b0'])")
            lines.append(f"    ic.sbend(offset={float(sep)/2},radius=20,width={ww}).put(_ab.pin['b0'])")
            lines.append(f"    nd.Pin('a0').put(0,0,180)")
            lines.append(f"    nd.Pin('b0').put({float(sl)*2+float(al)+float(dl)},0,0)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

        elif ct == "text_label":
            lines.append(f"# ── Text Label {cid}")
            txt=p.get('text','LABEL'); th=p.get('text_height',50)
            layer_name=p.get('layer','SiNWG')
            PDK_LN={"GraphBot":78,"GraphTop":79,"GraphGate":118,"GraphCont":85,"GraphMetal1":109,"GraphMet1L":110,"SiWG":86,"SiNWG":119,"SiGrating":87,"SiNGrating":88,"GraphPas":89,"GraphPAD":97,"Alignment":234,"SiN":119,"GM1":109}
            ln=PDK_LN.get(layer_name,119)
            lines.append(f"{v} = nd.text(text='{txt}',height={th},layer={ln})")
            lines.append("")

        elif ct == "gsg_pad":
            lines.append(f"# ── GSG Pad {cid}")
            pw=p.get('pad_width',80);ph=p.get('pad_height',80);pg=p.get('pad_gap',50)
            lines.append(f"with nd.Cell('GSG_{cid}') as {v}:")
            lines.append(f"    nd.Polygon(layer=109,points=geom.rectangle(length={pw},height={ph})).put(0,0)")
            lines.append(f"    nd.Polygon(layer=109,points=geom.rectangle(length={pw},height={ph})).put({float(pw)+float(pg)},0)")
            lines.append(f"    nd.Polygon(layer=109,points=geom.rectangle(length={pw},height={ph})).put({float(pw)*2+float(pg)*2},0)")
            lines.append(f"    nd.Pin('gnd_l').put({float(pw)/2},{float(ph)/2},90)")
            lines.append(f"    nd.Pin('sig').put({float(pw)+float(pg)+float(pw)/2},{float(ph)/2},90)")
            lines.append(f"    nd.Pin('gnd_r').put({float(pw)*2+float(pg)*2+float(pw)/2},{float(ph)/2},90)")
            lines.append(f"    nd.put_stub()")
            lines.append("")

    # Assembly
    lines.append("# ── Assembly ──────────────────────────────────────────────")
    lines.append("top = nd.Cell('TOP')")
    lines.append("with top:")

    gc_connections = {}
    pin_connections = {}
    if connections:
        for cn in connections:
            fc = comp_map.get(cn.get("fromComp"))
            tc = comp_map.get(cn.get("toComp"))
            if fc and fc["type"] == "grating_coupler":
                gc_connections[fc["id"]] = tc["id"] if tc else None
            if tc and tc["type"] == "grating_coupler":
                gc_connections[tc["id"]] = fc["id"] if fc else None
            if fc and tc:
                pin_connections[fc["id"]] = {
                    "pin": cn.get("fromPin"), "target_id": tc["id"],
                    "target_pin": cn.get("toPin")
                }
                pin_connections[tc["id"]] = {
                    "pin": cn.get("toPin"), "target_id": fc["id"],
                    "target_pin": cn.get("fromPin")
                }

    for c in components:
        x = round(float(c.get("x", 0)), 2)
        y = round(-float(c.get("y", 0)), 2)
        rot = int(c.get("rotation", 0) or 0)

        if c["type"] == "grating_coupler" and c["id"] in gc_connections:
            target_id = gc_connections[c["id"]]
            target = comp_map.get(target_id)
            if target:
                target_x = round(float(target.get("x", 0)), 2)
                if x < target_x and rot == 0:
                    rot = 180

        pargs = f"{x}, {y}, {rot}" if rot else f"{x}, {y}"
        lines.append(f"    {_vname(c)}_inst = {_vname(c)}.put({pargs})")

    if connections:
        lines.append("    # connections")
        PIN_MAP = {
            "grating_coupler": {"wg_out": "a0", "gc_in": "a0"},
            "bond_pad": {"pad_l": "a0", "pad_r": "b0", "pad_t": "a1", "pad_b": "b1", "pad_a": "b1"},
        }
        def _map_pin(comp, pin_name):
            ct = comp.get("type", "")
            return PIN_MAP.get(ct, {}).get(pin_name, pin_name)

        for cn in connections:
            fc = comp_map.get(cn.get("fromComp"))
            tc = comp_map.get(cn.get("toComp"))
            if not fc or not tc: continue
            fv = _vname(fc)+"_inst"; tv = _vname(tc)+"_inst"
            fp = _map_pin(fc, cn.get("fromPin","b0"))
            tp = _map_pin(tc, cn.get("toPin","a0"))
            layer = cn.get("layer","SiN"); route = cn.get("routeType","auto")
            obj = "gm1" if layer == "GM1" else "ic"
            w   = float(cn.get("width", 3.0 if layer == "GM1" else fc["params"].get("wg_width", 0.7)))
            R   = float(cn.get("radius", 50 if layer == "GM1" else 100))
            p1  = f"{fv}.pin['{fp}']"; p2  = f"{tv}.pin['{tp}']"
            if route == "strt_p2p":
                lines.append(f"    {obj}.strt_p2p(pin1={p1},pin2={p2},width={w}).put()")
            elif route == "sbend_p2p":
                lines.append(f"    {obj}.sbend_p2p(pin1={p1},pin2={p2},radius={R},width={w}).put()")
            elif route == "cobra_p2p":
                lines.append(f"    {obj}.cobra_p2p(pin1={p1},pin2={p2},width1={w},width2={w}).put()")
            elif route == "bend_strt_bend_p2p":
                lines.append(f"    {obj}.bend_strt_bend_p2p(pin1={p1},pin2={p2},radius={R},width={w}).put()")
            elif route == "ubend_p2p":
                lines.append(f"    {obj}.ubend_p2p(pin1={p1},pin2={p2},radius={R},width={w}).put()")
            elif route == "sinebend_p2p":
                lines.append(f"    # Sine bend — uses distance/offset form")
                lines.append(f"    {obj}.sbend_p2p(pin1={p1},pin2={p2},radius={R},width={w}).put()  # fallback to sbend")
            elif route == "strt_bend_strt_p2p":
                lines.append(f"    {obj}.strt_bend_strt_p2p(pin1={p1},pin2={p2},radius={R},width={w}).put()")
            elif route == "taper_p2p":
                w2 = float(cn.get("width2", w))
                lines.append(f"    {obj}.taper_p2p(pin1={p1},pin2={p2},width1={w},width2={w2}).put()")
            elif route == "pcurve_p2p":
                lines.append(f"    {obj}.pcurve_p2p(pin1={p1},pin2={p2},width={w}).put()")
            else:  # auto
                lines.append(f"    {obj}.sbend_p2p(pin1={p1},pin2={p2},radius={R},width={w}).put()")

    lines += ["", "nd.export_gds(topcells=top, filename='photonic_design.gds')",
              "print('Exported: photonic_design.gds')"]
    return jsonify({"code": "\n".join(lines)})


@app.route("/api/export_gds", methods=["POST"])
def export_gds():
    if not NAZCA_AVAILABLE:
        return jsonify({"error": "nazca/IHP_PDK not installed."}), 500
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data received."}), 400
    components  = data.get("components", [])
    connections = data.get("connections", [])
    filename    = data.get("filename", "photonic_design.gds")
    if not components:
        return jsonify({"error": "No components."}), 400
    try:
        comp_map = {}
        tmpdir = tempfile.mkdtemp()
        gds_path = os.path.join(tmpdir, filename)
        top = nd.Cell("TOP")
        with top:
            gc_conns = {}
            pin_conns = set()
            comp_dict = {c["id"]: c for c in components}
            for cn in connections:
                fid, tid = cn.get("fromComp"), cn.get("toComp")
                if comp_dict.get(fid, {}).get("type") == "grating_coupler":
                    gc_conns[fid] = tid
                if comp_dict.get(tid, {}).get("type") == "grating_coupler":
                    gc_conns[tid] = fid
                pin_conns.add(fid)
                pin_conns.add(tid)

            for c in components:
                cell = build_cell(c["id"], c["type"], c["params"])
                x = round(float(c.get("x", 0)), 2)
                y = round(-float(c.get("y", 0)), 2)  # Y-flip for GDS
                rot = int(c.get("rotation", 0) or 0)
                
                # Negate rotation angle because:
                # - React uses screen coords (Y down) and rotates clockwise
                # - GDS uses math coords (Y up) and rotates counter-clockwise
                gds_rot = -rot
                
                inst = cell.put(x, y, gds_rot)
                comp_map[c["id"]] = {"cell": cell, "inst": inst, "data": c}

            _pin_map = {
                "grating_coupler": {"wg_out": "a0", "gc_in": "a0"},
                "bond_pad": {"pad_l": "a0", "pad_r": "b0", "pad_t": "a1", "pad_b": "b1", "pad_a": "b1"},
            }
            def _resolve_pin(comp_data, pin_name):
                ct = comp_data.get("type", "")
                return _pin_map.get(ct, {}).get(pin_name, pin_name)

            for cn in connections:
                fc = comp_map.get(cn.get("fromComp"))
                tc = comp_map.get(cn.get("toComp"))
                if not fc or not tc:
                    continue
                try:
                    fi = fc["inst"]; ti = tc["inst"]
                    fp = _resolve_pin(fc["data"], cn.get("fromPin", "b0"))
                    tp = _resolve_pin(tc["data"], cn.get("toPin", "a0"))
                    layer = cn.get("layer", "SiN")
                    route = cn.get("routeType", "auto")
                    ic_obj = ihp.IC_GM1 if layer == "GM1" else ihp.IC_SiNBWG
                    w = float(cn.get("width", 3.0 if layer == "GM1" else fc["data"]["params"].get("wg_width", 0.7)))
                    R = float(cn.get("radius", 50 if layer == "GM1" else 100))
                    
                    # Get base pins
                    base_p1 = fi.pin[fp]
                    base_p2 = ti.pin[tp]
                    
                    # Check for custom angles - if set, create new pins with those angles
                    from_angle = cn.get("fromAngle")
                    to_angle = cn.get("toAngle")
                    
                    if from_angle is not None:
                        p1 = nd.Pin().put(base_p1.x, base_p1.y, -float(from_angle))
                    else:
                        p1 = base_p1
                    
                    if to_angle is not None:
                        p2 = nd.Pin().put(base_p2.x, base_p2.y, -float(to_angle))
                    else:
                        p2 = base_p2
                    
                    if route == "strt_p2p":
                        ic_obj.strt_p2p(pin1=p1, pin2=p2, width=w).put()
                    elif route == "ubend_p2p":
                        ic_obj.ubend_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                    elif route == "cobra_p2p":
                        ic_obj.cobra_p2p(pin1=p1, pin2=p2, width1=w, width2=w).put()
                    elif route == "bend_strt_bend_p2p":
                        ic_obj.bend_strt_bend_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                    elif route == "strt_bend_strt_p2p":
                        ic_obj.strt_bend_strt_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                    elif route == "sinebend_p2p":
                        ic_obj.sinebend_p2p(pin1=p1, pin2=p2, width=w).put()
                    elif route == "pcurve_p2p":
                        ic_obj.pcurve_p2p(pin1=p1, pin2=p2, width=w).put()
                    elif route == "taper_p2p":
                        w2 = float(cn.get("width2", w))
                        ic_obj.taper_p2p(pin1=p1, pin2=p2, width1=w, width2=w2).put()
                    else:
                        ic_obj.sbend_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                except Exception as ce:
                    print(f"[WARN] Connection route failed: {ce}")

        nd.export_gds(topcells=top, filename=gds_path)
        fixed_gds = os.path.join(os.path.dirname(os.path.abspath(__file__)), "photonic_design.gds")
        import shutil
        shutil.copy2(gds_path, fixed_gds)
        return send_file(gds_path, as_attachment=True,
                         download_name=filename, mimetype="application/octet-stream")
    except Exception as e:
        return jsonify({"error": str(e), "traceback": traceback.format_exc()}), 500


@app.route("/api/open_klayout", methods=["POST"])
def open_klayout():
    if not NAZCA_AVAILABLE:
        return jsonify({"error": "nazca not installed"}), 500
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400
    components = data.get("components", [])
    connections = data.get("connections", [])
    if not components:
        return jsonify({"error": "No components"}), 400
    try:
        gds_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "photonic_design.gds")

        comp_map = {}
        top = nd.Cell("TOP_KL")
        with top:
            comp_dict = {c["id"]: c for c in components}
            gc_conns = {}
            for cn in connections:
                fid, tid = cn.get("fromComp"), cn.get("toComp")
                if comp_dict.get(fid, {}).get("type") == "grating_coupler": gc_conns[fid] = tid
                if comp_dict.get(tid, {}).get("type") == "grating_coupler": gc_conns[tid] = fid
            for c in components:
                cell = build_cell(c["id"], c["type"], c["params"])
                x = round(float(c.get("x", 0)), 2)
                y = round(-float(c.get("y", 0)), 2)  # Y-flip for GDS
                rot = int(c.get("rotation", 0) or 0)
                
                # Negate rotation angle because:
                # - React uses screen coords (Y down) and rotates clockwise
                # - GDS uses math coords (Y up) and rotates counter-clockwise
                gds_rot = -rot
                
                inst = cell.put(x, y, gds_rot)
                comp_map[c["id"]] = {"cell": cell, "inst": inst, "data": c}

            # ── Route connections ──────────────────────────────────────────
            _pin_map = {
                "grating_coupler": {"wg_out": "a0", "gc_in": "a0"},
                "bond_pad": {"pad_l": "a0", "pad_r": "b0", "pad_t": "a1", "pad_b": "b1", "pad_a": "b1"},
            }
            def _resolve_pin(comp_data, pin_name):
                ct = comp_data.get("type", "")
                return _pin_map.get(ct, {}).get(pin_name, pin_name)

            for cn in connections:
                fc = comp_map.get(cn.get("fromComp"))
                tc = comp_map.get(cn.get("toComp"))
                if not fc or not tc:
                    continue
                try:
                    fi = fc["inst"]; ti = tc["inst"]
                    fp = _resolve_pin(fc["data"], cn.get("fromPin", "b0"))
                    tp = _resolve_pin(tc["data"], cn.get("toPin", "a0"))
                    layer = cn.get("layer", "SiN")
                    route = cn.get("routeType", "auto")
                    ic_obj = ihp.IC_GM1 if layer == "GM1" else ihp.IC_SiNBWG
                    w = float(cn.get("width", 3.0 if layer == "GM1" else fc["data"]["params"].get("wg_width", 0.7)))
                    R = float(cn.get("radius", 50 if layer == "GM1" else 100))
                    
                    # Get base pins
                    base_p1 = fi.pin[fp]
                    base_p2 = ti.pin[tp]
                    
                    # Check for custom angles - if set, create new pins with those angles
                    from_angle = cn.get("fromAngle")
                    to_angle = cn.get("toAngle")
                    
                    if from_angle is not None:
                        p1 = nd.Pin().put(base_p1.x, base_p1.y, -float(from_angle))
                    else:
                        p1 = base_p1
                    
                    if to_angle is not None:
                        p2 = nd.Pin().put(base_p2.x, base_p2.y, -float(to_angle))
                    else:
                        p2 = base_p2
                    
                    if route == "strt_p2p":
                        ic_obj.strt_p2p(pin1=p1, pin2=p2, width=w).put()
                    elif route == "ubend_p2p":
                        ic_obj.ubend_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                    elif route == "cobra_p2p":
                        ic_obj.cobra_p2p(pin1=p1, pin2=p2, width1=w, width2=w).put()
                    elif route == "bend_strt_bend_p2p":
                        ic_obj.bend_strt_bend_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                    elif route == "strt_bend_strt_p2p":
                        ic_obj.strt_bend_strt_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                    elif route == "taper_p2p":
                        w2 = float(cn.get("width2", w))
                        ic_obj.taper_p2p(pin1=p1, pin2=p2, width1=w, width2=w2).put()
                    elif route == "pcurve_p2p":
                        ic_obj.pcurve_p2p(pin1=p1, pin2=p2, width=w).put()
                    elif route == "sinebend_p2p":
                        ic_obj.sinebend_p2p(pin1=p1, pin2=p2, width=w).put()
                    else:  # auto, sbend_p2p
                        ic_obj.sbend_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                except Exception as ce:
                    print(f"[WARN] Connection route failed in open_klayout: {ce}")

        nd.export_gds(topcells=top, filename=gds_path)

        import subprocess
        klayout_paths = [
            r"C:\Program Files\KLayout\klayout_app.exe",
            r"C:\Program Files (x86)\KLayout\klayout_app.exe",
            r"C:\Users\dubey\AppData\Local\Programs\KLayout\klayout_app.exe",
            "klayout",
        ]
        opened = False
        for kl in klayout_paths:
            try:
                subprocess.Popen([kl, gds_path])
                opened = True
                break
            except (FileNotFoundError, OSError):
                continue

        if opened:
            return jsonify({"ok": True, "message": f"Opened in KLayout: {gds_path}"})
        else:
            try:
                os.startfile(gds_path)
                return jsonify({"ok": True, "message": f"Opened with default app: {gds_path}"})
            except Exception:
                return jsonify({"ok": False, "error": f"GDS saved to {gds_path} but KLayout not found."})
    except Exception as e:
        return jsonify({"error": str(e), "traceback": traceback.format_exc()}), 500


@app.route("/api/validate", methods=["POST"])
def validate():
    data = request.get_json()
    if not data:
        return jsonify({"issues": ["No data"], "ok": False}), 400
    comp = data.get("component", {})
    p    = comp.get("params", {})
    ct   = comp.get("type", "")
    issues = []
    if ct in ("ring_resonator", "racetrack_resonator", "ring_no_pad"):
        r = float(p.get("radius", 80)); gl = float(p.get("gr_length", 10))
        if gl > 2*3.14159*r: issues.append("Graphene arc exceeds ring circumference.")
        if float(p.get("gap", 0.5)) < 0.1: issues.append("Gap < 0.1 µm — fabrication risk.")
        if ct != "ring_no_pad" and float(p.get("pad_size", 80)) > 2*float(p.get("radius", 80)):
            issues.append("Pad size larger than ring diameter.")
    if ct == "straight_eam":
        if float(p.get("gr_width", 8)) > 20: issues.append("Graphene width > 20 µm unusually large.")
        if float(p.get("wg_width", 0.7)) < 0.3: issues.append("WG width < 0.3 µm below fab limit.")
        if float(p.get("via_size", 0.36)) < 0.1: issues.append("Via size < 0.1 µm too small.")
    if ct == "grating_coupler":
        ff = float(p.get("ff", 0.5))
        if not (0 < ff < 1): issues.append("Fill factor must be between 0 and 1.")
    if ct == "bond_pad":
        if float(p.get("pad_length", 80)) < 10: issues.append("Pad length < 10 µm too small for bonding.")
    return jsonify({"issues": issues, "ok": len(issues) == 0})


# ═══════════════════════════════════════════════════════════════════════════════
#  DRC CHECK - IHP Graphene Design Rules (Layout Rules Rev. 0.1)
# ═══════════════════════════════════════════════════════════════════════════════

# Layer number mapping (from IHP DRC file)
DRC_LAYERS = {
    78: "GraphBot",
    79: "GraphTop", 
    85: "GraphCont",
    109: "GraphMet1",
    110: "GraphMet1L",
    118: "GraphGat",
    119: "SiNWG",
    86: "SiWG",
    87: "SiGrating",
    88: "SiNGrating",
    89: "GraphPass",
    97: "GraphPAD",
}

# Design rules from IHP DRC (in µm)
DRC_RULES = {
    # GraphBot (78)
    "GRB.a": {"layer": 78, "rule": "min_width", "value": 1.0, "desc": "Min. GraphBot width"},
    "GRB.b": {"layer": 78, "rule": "min_space", "value": 5.0, "desc": "Min. GraphBot space"},
    "GRB.c": {"layer": 78, "rule": "min_area", "value": 1.0, "desc": "Min. GraphBot area"},
    
    # GraphTop (79)
    "GRT.a": {"layer": 79, "rule": "min_width", "value": 1.0, "desc": "Min. GraphTop width"},
    "GRT.b": {"layer": 79, "rule": "min_space", "value": 5.0, "desc": "Min. GraphTop space"},
    "GRT.c": {"layer": 79, "rule": "min_area", "value": 1.0, "desc": "Min. GraphTop area"},
    
    # GraphGat (118)
    "GRG.a": {"layer": 118, "rule": "min_width", "value": 0.25, "desc": "Min. GraphGat width"},
    "GRG.b": {"layer": 118, "rule": "min_space", "value": 0.25, "desc": "Min. GraphGat space"},
    "GRG.c": {"layer": 118, "rule": "min_area", "value": 1.0, "desc": "Min. GraphGat area"},
    
    # SiNWG (119)
    "SNW.a": {"layer": 119, "rule": "min_width", "value": 0.2, "desc": "Min. SiNWG width"},
    "SNW.b": {"layer": 119, "rule": "min_space", "value": 0.15, "desc": "Min. SiNWG space"},
    "SNW.c": {"layer": 119, "rule": "min_area", "value": 5.0, "desc": "Min. SiNWG area"},
    "SNW.d": {"layer": 119, "rule": "min_sep", "other_layer": 109, "value": 0.25, "desc": "Min. SiNWG to GraphMet1 spacing"},
    
    # SiWG (86)  
    "SWG.a": {"layer": 86, "rule": "min_width", "value": 0.15, "desc": "Min. SiWG width"},
    "SWG.b": {"layer": 86, "rule": "min_space", "value": 0.13, "desc": "Min. SiWG space"},
    "SWG.c": {"layer": 86, "rule": "min_area", "value": 5.0, "desc": "Min. SiWG area"},
    
    # SiNGrating (88)
    "GNC.a": {"layer": 88, "rule": "min_width", "value": 0.25, "desc": "Min. SiNGrating width"},
    "GNC.b": {"layer": 88, "rule": "min_space", "value": 0.25, "desc": "Min. SiNGrating space"},
    
    # SiGrating (87)
    "GSC.a": {"layer": 87, "rule": "min_width", "value": 0.25, "desc": "Min. SiGrating width"},
    "GSC.b": {"layer": 87, "rule": "min_space", "value": 0.25, "desc": "Min. SiGrating space"},
    
    # GraphCont (85)
    "GCT.a": {"layer": 85, "rule": "exact_size", "value": 0.36, "desc": "GraphCont must be 0.36µm square"},
    "GCT.b": {"layer": 85, "rule": "min_space", "value": 0.36, "desc": "Min. GraphCont space"},
    
    # GraphMet1 (109)
    "GM1.a": {"layer": 109, "rule": "min_width", "value": 2.0, "desc": "Min. GraphMet1 width"},
    "GM1.b": {"layer": 109, "rule": "min_space", "value": 1.0, "desc": "Min. GraphMet1 space"},
    "GM1.d": {"layer": 109, "rule": "min_area", "value": 4.0, "desc": "Min. GraphMet1 area"},
    
    # GraphMet1L (110)
    "GML.a": {"layer": 110, "rule": "min_width", "value": 2.0, "desc": "Min. GraphMet1L width"},
    "GML.b": {"layer": 110, "rule": "min_space", "value": 1.0, "desc": "Min. GraphMet1L space"},
    "GML.d": {"layer": 110, "rule": "min_area", "value": 4.0, "desc": "Min. GraphMet1L area"},
    
    # GraphPass (89)
    "GPS.a": {"layer": 89, "rule": "min_width", "value": 1.0, "desc": "Min. GraphPass width"},
    "GPS.b": {"layer": 89, "rule": "min_space", "value": 5.0, "desc": "Min. GraphPass space"},
    "GPS.c": {"layer": 89, "rule": "min_area", "value": 1.0, "desc": "Min. GraphPass area"},
    
    # GraphPAD (97)
    "GPD.a": {"layer": 97, "rule": "min_width", "value": 2.0, "desc": "Min. GraphPAD width"},
    "GPD.b": {"layer": 97, "rule": "min_space", "value": 2.0, "desc": "Min. GraphPAD space"},
    "GPD.c": {"layer": 97, "rule": "min_area", "value": 5.0, "desc": "Min. GraphPAD area"},
}

def compute_polygon_metrics(points):
    """Compute width, height, area for a polygon."""
    if not points or len(points) < 3:
        return {"width": 0, "height": 0, "area": 0, "min_x": 0, "max_x": 0, "min_y": 0, "max_y": 0}
    
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    width = max_x - min_x
    height = max_y - min_y
    
    # Shoelace formula for area
    n = len(points)
    area = 0
    for i in range(n):
        j = (i + 1) % n
        area += points[i][0] * points[j][1]
        area -= points[j][0] * points[i][1]
    area = abs(area) / 2
    
    return {
        "width": width, 
        "height": height, 
        "area": area,
        "min_x": min_x, "max_x": max_x,
        "min_y": min_y, "max_y": max_y,
        "min_dim": min(width, height)  # minimum dimension (approx width for rectangles)
    }


def check_polygon_spacing(polys1, polys2):
    """Check minimum spacing between two sets of polygons (simplified bbox check)."""
    min_spacing = float('inf')
    for p1 in polys1:
        m1 = compute_polygon_metrics(p1.get("points", []))
        for p2 in polys2:
            m2 = compute_polygon_metrics(p2.get("points", []))
            # Simple bbox distance
            dx = max(0, max(m1["min_x"], m2["min_x"]) - min(m1["max_x"], m2["max_x"]))
            dy = max(0, max(m1["min_y"], m2["min_y"]) - min(m1["max_y"], m2["max_y"]))
            dist = (dx**2 + dy**2)**0.5 if dx > 0 or dy > 0 else 0
            min_spacing = min(min_spacing, dist)
    return min_spacing


@app.route("/api/drc_check", methods=["POST"])
def drc_check():
    """
    Run DRC checks on the design based on IHP Graphene design rules.
    Returns a list of violations with rule ID, description, and location.
    """
    data = request.get_json()
    if not data:
        return jsonify({"errors": [], "warnings": [], "ok": True, "message": "No data"})
    
    components = data.get("components", [])
    if not components:
        return jsonify({"errors": [], "warnings": [], "ok": True, "message": "No components"})
    
    errors = []  # Critical DRC violations
    warnings = []  # Minor issues or recommendations
    
    # Collect all polygons by layer across all components
    polygons_by_layer = {}
    
    for comp in components:
        comp_id = comp.get("id", "unknown")
        comp_type = comp.get("type", "unknown")
        params = comp.get("params", {})
        x_offset = float(comp.get("x", 0))
        y_offset = float(comp.get("y", 0))
        
        # Get polygons from imported GDS or custom blocks
        all_polygons = params.get("all_polygons", [])
        
        for poly_data in all_polygons:
            layer = int(poly_data.get("layer", 119))
            points = poly_data.get("points", [])
            
            if not points:
                continue
            
            # Offset points by component position
            offset_points = [(p[0] + x_offset, p[1] + y_offset) for p in points]
            
            if layer not in polygons_by_layer:
                polygons_by_layer[layer] = []
            polygons_by_layer[layer].append({
                "points": offset_points,
                "comp_id": comp_id,
                "comp_type": comp_type
            })
        
        # Also check component-specific rules based on type and params
        if comp_type == "straight_eam":
            gr_width = float(params.get("gr_width", 8))
            wg_width = float(params.get("wg_width", 0.7))
            via_size = float(params.get("via_size", 0.36))
            
            # GraphBot width check (GRB.a)
            if gr_width < 1.0:
                errors.append({
                    "rule": "GRB.a",
                    "comp_id": comp_id,
                    "message": f"GraphBot width {gr_width}µm < 1.0µm minimum",
                    "severity": "error"
                })
            
            # SiNWG width check (SNW.a)
            if wg_width < 0.2:
                errors.append({
                    "rule": "SNW.a",
                    "comp_id": comp_id,
                    "message": f"SiNWG width {wg_width}µm < 0.2µm minimum",
                    "severity": "error"
                })
            
            # GraphCont size check (GCT.a)
            if abs(via_size - 0.36) > 0.01:
                warnings.append({
                    "rule": "GCT.a",
                    "comp_id": comp_id,
                    "message": f"GraphCont size {via_size}µm ≠ 0.36µm (required exact size)",
                    "severity": "warning"
                })
        
        elif comp_type in ("ring_resonator", "racetrack_resonator", "ring_no_pad"):
            gap = float(params.get("gap", 0.5))
            wg_width = float(params.get("wg_width", 0.7))
            gr_width = float(params.get("gr_width", 3))
            
            # SiNWG spacing check (SNW.b)
            if gap < 0.15:
                errors.append({
                    "rule": "SNW.b",
                    "comp_id": comp_id,
                    "message": f"Ring-bus gap {gap}µm < 0.15µm minimum SiNWG spacing",
                    "severity": "error"
                })
            
            if wg_width < 0.2:
                errors.append({
                    "rule": "SNW.a",
                    "comp_id": comp_id,
                    "message": f"Waveguide width {wg_width}µm < 0.2µm minimum",
                    "severity": "error"
                })
            
            if gr_width < 1.0:
                errors.append({
                    "rule": "GRB.a",
                    "comp_id": comp_id,
                    "message": f"Graphene width {gr_width}µm < 1.0µm minimum",
                    "severity": "error"
                })
        
        elif comp_type == "grating_coupler":
            wg_width = float(params.get("wg_width", 0.7))
            period = float(params.get("period", 0.6))
            ff = float(params.get("ff", 0.5))
            
            # SiNGrating width/space checks (GNC.a, GNC.b)
            tooth_width = period * ff
            gap_width = period * (1 - ff)
            
            if tooth_width < 0.25:
                errors.append({
                    "rule": "GNC.a",
                    "comp_id": comp_id,
                    "message": f"Grating tooth width {tooth_width:.3f}µm < 0.25µm minimum",
                    "severity": "error"
                })
            
            if gap_width < 0.25:
                errors.append({
                    "rule": "GNC.b",
                    "comp_id": comp_id,
                    "message": f"Grating gap width {gap_width:.3f}µm < 0.25µm minimum",
                    "severity": "error"
                })
        
        elif comp_type == "bond_pad":
            pad_width = float(params.get("pad_width", 80))
            pad_length = float(params.get("pad_length", 80))
            
            # GraphPAD checks (GPD.a, GPD.c)
            if pad_width < 2.0:
                errors.append({
                    "rule": "GPD.a",
                    "comp_id": comp_id,
                    "message": f"Pad width {pad_width}µm < 2.0µm minimum",
                    "severity": "error"
                })
            
            if pad_width * pad_length < 5.0:
                errors.append({
                    "rule": "GPD.c",
                    "comp_id": comp_id,
                    "message": f"Pad area {pad_width*pad_length}µm² < 5.0µm² minimum",
                    "severity": "error"
                })
        
        elif comp_type == "gsg_pad":
            pad_width = float(params.get("pad_width", 80))
            pad_gap = float(params.get("pad_gap", 50))
            
            if pad_width < 2.0:
                errors.append({
                    "rule": "GPD.a",
                    "comp_id": comp_id,
                    "message": f"GSG pad width {pad_width}µm < 2.0µm minimum",
                    "severity": "error"
                })
            
            if pad_gap < 2.0:
                errors.append({
                    "rule": "GPD.b",
                    "comp_id": comp_id,
                    "message": f"GSG pad gap {pad_gap}µm < 2.0µm minimum spacing",
                    "severity": "error"
                })
        
        elif comp_type == "mmi_splitter":
            wg_width = float(params.get("wg_width", 0.7))
            mmi_width = float(params.get("mmi_width", 4))
            
            if wg_width < 0.2:
                errors.append({
                    "rule": "SNW.a",
                    "comp_id": comp_id,
                    "message": f"MMI waveguide width {wg_width}µm < 0.2µm minimum",
                    "severity": "error"
                })
        
        elif comp_type == "directional_coupler":
            gap = float(params.get("gap", 0.3))
            wg_width = float(params.get("wg_width", 0.7))
            
            if gap < 0.15:
                errors.append({
                    "rule": "SNW.b",
                    "comp_id": comp_id,
                    "message": f"DC coupling gap {gap}µm < 0.15µm minimum SiNWG spacing",
                    "severity": "error"
                })
            
            if wg_width < 0.2:
                errors.append({
                    "rule": "SNW.a",
                    "comp_id": comp_id,
                    "message": f"DC waveguide width {wg_width}µm < 0.2µm minimum",
                    "severity": "error"
                })
    
    # Check polygon-level rules for imported/custom components
    for layer, polys in polygons_by_layer.items():
        layer_name = DRC_LAYERS.get(layer, f"Layer {layer}")
        
        for poly in polys:
            metrics = compute_polygon_metrics(poly["points"])
            comp_id = poly["comp_id"]
            
            # Check width rules
            if layer == 119:  # SiNWG
                if metrics["min_dim"] < 0.2 and metrics["min_dim"] > 0:
                    errors.append({
                        "rule": "SNW.a",
                        "comp_id": comp_id,
                        "message": f"SiNWG polygon width {metrics['min_dim']:.3f}µm < 0.2µm",
                        "severity": "error"
                    })
                if metrics["area"] < 5.0 and metrics["area"] > 0:
                    warnings.append({
                        "rule": "SNW.c",
                        "comp_id": comp_id,
                        "message": f"SiNWG polygon area {metrics['area']:.3f}µm² < 5.0µm²",
                        "severity": "warning"
                    })
            
            elif layer == 78:  # GraphBot
                if metrics["min_dim"] < 1.0 and metrics["min_dim"] > 0:
                    errors.append({
                        "rule": "GRB.a",
                        "comp_id": comp_id,
                        "message": f"GraphBot polygon width {metrics['min_dim']:.3f}µm < 1.0µm",
                        "severity": "error"
                    })
            
            elif layer == 79:  # GraphTop
                if metrics["min_dim"] < 1.0 and metrics["min_dim"] > 0:
                    errors.append({
                        "rule": "GRT.a",
                        "comp_id": comp_id,
                        "message": f"GraphTop polygon width {metrics['min_dim']:.3f}µm < 1.0µm",
                        "severity": "error"
                    })
            
            elif layer == 109:  # GraphMet1
                if metrics["min_dim"] < 2.0 and metrics["min_dim"] > 0:
                    errors.append({
                        "rule": "GM1.a",
                        "comp_id": comp_id,
                        "message": f"GraphMet1 polygon width {metrics['min_dim']:.3f}µm < 2.0µm",
                        "severity": "error"
                    })
                if metrics["area"] < 4.0 and metrics["area"] > 0:
                    warnings.append({
                        "rule": "GM1.d",
                        "comp_id": comp_id,
                        "message": f"GraphMet1 polygon area {metrics['area']:.3f}µm² < 4.0µm²",
                        "severity": "warning"
                    })
            
            elif layer == 97:  # GraphPAD
                if metrics["min_dim"] < 2.0 and metrics["min_dim"] > 0:
                    errors.append({
                        "rule": "GPD.a",
                        "comp_id": comp_id,
                        "message": f"GraphPAD polygon width {metrics['min_dim']:.3f}µm < 2.0µm",
                        "severity": "error"
                    })
    
    # Check spacing between SiNWG and GraphMet1 (SNW.d)
    if 119 in polygons_by_layer and 109 in polygons_by_layer:
        spacing = check_polygon_spacing(polygons_by_layer[119], polygons_by_layer[109])
        if spacing < 0.25 and spacing > 0:
            errors.append({
                "rule": "SNW.d",
                "comp_id": "global",
                "message": f"SiNWG to GraphMet1 spacing {spacing:.3f}µm < 0.25µm",
                "severity": "error"
            })
    
    # Summary
    ok = len(errors) == 0
    summary = f"{len(errors)} errors, {len(warnings)} warnings"
    
    return jsonify({
        "ok": ok,
        "errors": errors,
        "warnings": warnings,
        "summary": summary,
        "rules_checked": list(DRC_RULES.keys()),
        "layers_analyzed": list(polygons_by_layer.keys())
    })


@app.route("/api/drc_rules", methods=["GET"])
def get_drc_rules():
    """Return all DRC rules for display in the UI."""
    return jsonify({
        "rules": DRC_RULES,
        "layers": DRC_LAYERS
    })


# ═══════════════════════════════════════════════════════════════════════════════
#  CUSTOM PDK MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════════

# Default IHP PDK definition
DEFAULT_PDK = {
    "name": "IHP SiN Photonics",
    "version": "1.0",
    "description": "IHP Graphene-SiN Photonics PDK",
    "layers": {
        "119": {"name": "SiNWG", "description": "SiN Waveguide", "color": "#0000ff", "opacity": 0.75, "pattern": "solid", "gds_layer": 119, "gds_datatype": 0},
        "86": {"name": "SiWG", "description": "Si Waveguide", "color": "#0000ff", "opacity": 0.7, "pattern": "hatch", "gds_layer": 86, "gds_datatype": 0},
        "78": {"name": "GraphBot", "description": "Graphene Bottom", "color": "#ff0000", "opacity": 0.7, "pattern": "diagonal", "gds_layer": 78, "gds_datatype": 0},
        "79": {"name": "GraphTop", "description": "Graphene Top", "color": "#ff0000", "opacity": 0.65, "pattern": "dots", "gds_layer": 79, "gds_datatype": 0},
        "85": {"name": "GraphCont", "description": "Graphene Contact/Via", "color": "#ddff00", "opacity": 0.8, "pattern": "solid", "gds_layer": 85, "gds_datatype": 0},
        "88": {"name": "SiNGrating", "description": "SiN Grating", "color": "#80fffb", "opacity": 0.7, "pattern": "hatch", "gds_layer": 88, "gds_datatype": 0},
        "87": {"name": "SiGrating", "description": "Si Grating", "color": "#80fffb", "opacity": 0.7, "pattern": "hatch", "gds_layer": 87, "gds_datatype": 0},
        "89": {"name": "GraphPass", "description": "Passivation", "color": "#01ff6b", "opacity": 0.7, "pattern": "cross", "gds_layer": 89, "gds_datatype": 0},
        "97": {"name": "GraphPAD", "description": "Bond Pad Opening", "color": "#ff8000", "opacity": 0.8, "pattern": "solid", "gds_layer": 97, "gds_datatype": 0},
        "109": {"name": "GraphMetal1", "description": "Metal Layer 1", "color": "#ffae00", "opacity": 0.8, "pattern": "solid", "gds_layer": 109, "gds_datatype": 0},
        "110": {"name": "GraphMet1L", "description": "Metal Layer 1 Lift-off", "color": "#008050", "opacity": 0.75, "pattern": "hatch", "gds_layer": 110, "gds_datatype": 0},
        "118": {"name": "GraphGate", "description": "Graphene Gate", "color": "#ff0000", "opacity": 0.6, "pattern": "cross", "gds_layer": 118, "gds_datatype": 0},
        "234": {"name": "Alignment", "description": "Alignment Marks", "color": "#80fffb", "opacity": 0.5, "pattern": "dots", "gds_layer": 234, "gds_datatype": 0},
    },
    "design_rules": {
        "SiNWG": {"min_width": 0.2, "min_space": 0.15, "min_area": 5.0},
        "SiWG": {"min_width": 0.15, "min_space": 0.13, "min_area": 5.0},
        "GraphBot": {"min_width": 1.0, "min_space": 5.0, "min_area": 1.0},
        "GraphTop": {"min_width": 1.0, "min_space": 5.0, "min_area": 1.0},
        "GraphCont": {"exact_size": 0.36, "min_space": 0.36},
        "GraphMetal1": {"min_width": 2.0, "min_space": 1.0, "min_area": 4.0},
        "GraphPAD": {"min_width": 2.0, "min_space": 2.0, "min_area": 5.0},
    },
    "waveguide_types": {
        "SiN": {"layer": 119, "default_width": 0.7, "min_bend_radius": 50},
        "Si": {"layer": 86, "default_width": 0.5, "min_bend_radius": 10},
        "Metal": {"layer": 109, "default_width": 3.0, "min_bend_radius": 50},
    },
    "units": "um",
    "grid_resolution": 0.001,
}

# Store for custom PDKs (in production, use a database)
CUSTOM_PDKS = {}


@app.route("/api/pdk/list", methods=["GET"])
def list_pdks():
    """List all available PDKs."""
    pdks = [{"id": "ihp_sin", "name": DEFAULT_PDK["name"], "version": DEFAULT_PDK["version"], "builtin": True}]
    for pdk_id, pdk in CUSTOM_PDKS.items():
        pdks.append({"id": pdk_id, "name": pdk["name"], "version": pdk.get("version", "1.0"), "builtin": False})
    return jsonify({"pdks": pdks})


@app.route("/api/pdk/get/<pdk_id>", methods=["GET"])
def get_pdk(pdk_id):
    """Get full PDK definition."""
    if pdk_id == "ihp_sin":
        return jsonify({"pdk": DEFAULT_PDK})
    if pdk_id in CUSTOM_PDKS:
        return jsonify({"pdk": CUSTOM_PDKS[pdk_id]})
    return jsonify({"error": f"PDK '{pdk_id}' not found"}), 404


@app.route("/api/pdk/create", methods=["POST"])
def create_pdk():
    """Create a new custom PDK."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400
    
    pdk_id = data.get("id", "").strip().lower().replace(" ", "_")
    if not pdk_id:
        return jsonify({"error": "PDK ID is required"}), 400
    if pdk_id == "ihp_sin":
        return jsonify({"error": "Cannot overwrite built-in PDK"}), 400
    
    # Validate required fields
    pdk = {
        "name": data.get("name", pdk_id),
        "version": data.get("version", "1.0"),
        "description": data.get("description", ""),
        "layers": data.get("layers", {}),
        "design_rules": data.get("design_rules", {}),
        "waveguide_types": data.get("waveguide_types", {}),
        "units": data.get("units", "um"),
        "grid_resolution": data.get("grid_resolution", 0.001),
    }
    
    CUSTOM_PDKS[pdk_id] = pdk
    
    # Save to file for persistence
    pdk_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "custom_pdks")
    os.makedirs(pdk_dir, exist_ok=True)
    pdk_file = os.path.join(pdk_dir, f"{pdk_id}.json")
    try:
        import json
        with open(pdk_file, "w") as f:
            json.dump(pdk, f, indent=2)
    except Exception as e:
        print(f"[WARN] Could not save PDK to file: {e}")
    
    return jsonify({"ok": True, "message": f"PDK '{pdk_id}' created", "pdk": pdk})


@app.route("/api/pdk/delete/<pdk_id>", methods=["DELETE"])
def delete_pdk(pdk_id):
    """Delete a custom PDK."""
    if pdk_id == "ihp_sin":
        return jsonify({"error": "Cannot delete built-in PDK"}), 400
    if pdk_id not in CUSTOM_PDKS:
        return jsonify({"error": f"PDK '{pdk_id}' not found"}), 404
    
    del CUSTOM_PDKS[pdk_id]
    
    # Delete file
    pdk_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "custom_pdks")
    pdk_file = os.path.join(pdk_dir, f"{pdk_id}.json")
    try:
        if os.path.exists(pdk_file):
            os.remove(pdk_file)
    except Exception as e:
        print(f"[WARN] Could not delete PDK file: {e}")
    
    return jsonify({"ok": True, "message": f"PDK '{pdk_id}' deleted"})


@app.route("/api/pdk/export/<pdk_id>", methods=["GET"])
def export_pdk(pdk_id):
    """Export PDK as JSON file."""
    if pdk_id == "ihp_sin":
        pdk = DEFAULT_PDK
    elif pdk_id in CUSTOM_PDKS:
        pdk = CUSTOM_PDKS[pdk_id]
    else:
        return jsonify({"error": f"PDK '{pdk_id}' not found"}), 404
    
    import json
    from flask import Response
    response = Response(
        json.dumps(pdk, indent=2),
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment;filename={pdk_id}_pdk.json"}
    )
    return response


@app.route("/api/pdk/import", methods=["POST"])
def import_pdk():
    """Import PDK from JSON file."""
    if 'file' not in request.files:
        return jsonify({"error": "No file provided"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    
    try:
        import json
        content = file.read().decode('utf-8')
        pdk = json.loads(content)
        
        # Generate ID from name
        pdk_id = pdk.get("name", "custom").strip().lower().replace(" ", "_")
        
        # Ensure unique ID
        base_id = pdk_id
        counter = 1
        while pdk_id in CUSTOM_PDKS or pdk_id == "ihp_sin":
            pdk_id = f"{base_id}_{counter}"
            counter += 1
        
        CUSTOM_PDKS[pdk_id] = pdk
        
        return jsonify({"ok": True, "message": f"PDK imported as '{pdk_id}'", "pdk_id": pdk_id, "pdk": pdk})
    except json.JSONDecodeError as e:
        return jsonify({"error": f"Invalid JSON: {e}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdk/template", methods=["GET"])
def get_pdk_template():
    """
    Get a blank PDK template with documentation.
    This is the FOOLPROOF guide for creating a new PDK.
    """
    template = {
        "_documentation": {
            "overview": "This is a PDK (Process Design Kit) template. Fill in the values below to define your custom foundry process.",
            "steps": [
                "1. Set basic info: name, version, description",
                "2. Define layers: each layer needs a GDS layer number, name, color, and pattern",
                "3. Set design rules: minimum width, spacing, and area for each layer",
                "4. Define waveguide types: layer, default width, and minimum bend radius",
                "5. Save and use in the designer"
            ],
            "layer_patterns": ["solid", "hatch", "dots", "diagonal", "cross"],
            "color_format": "Hex color code like #ff0000 for red",
            "units": "All dimensions in micrometers (µm)"
        },
        
        "name": "My Custom PDK",
        "version": "1.0",
        "description": "Description of your foundry process",
        
        "layers": {
            "_example_layer": {
                "_comment": "Copy this structure for each layer in your process",
                "name": "LayerName",
                "description": "What this layer is used for",
                "gds_layer": 1,
                "gds_datatype": 0,
                "color": "#0000ff",
                "opacity": 0.75,
                "pattern": "solid"
            },
            "1": {
                "name": "Waveguide",
                "description": "Main optical waveguide layer",
                "gds_layer": 1,
                "gds_datatype": 0,
                "color": "#0000ff",
                "opacity": 0.75,
                "pattern": "solid"
            },
            "2": {
                "name": "Metal",
                "description": "Metal routing layer",
                "gds_layer": 2,
                "gds_datatype": 0,
                "color": "#ffae00",
                "opacity": 0.8,
                "pattern": "solid"
            },
            "3": {
                "name": "Via",
                "description": "Via/contact layer",
                "gds_layer": 3,
                "gds_datatype": 0,
                "color": "#ddff00",
                "opacity": 0.8,
                "pattern": "dots"
            }
        },
        
        "design_rules": {
            "_example_rule": {
                "_comment": "Define min_width, min_space, min_area for each layer",
                "min_width": 0.5,
                "min_space": 0.5,
                "min_area": 1.0
            },
            "Waveguide": {
                "min_width": 0.4,
                "min_space": 0.3,
                "min_area": 1.0
            },
            "Metal": {
                "min_width": 2.0,
                "min_space": 1.0,
                "min_area": 4.0
            },
            "Via": {
                "exact_size": 0.5,
                "min_space": 0.5
            }
        },
        
        "waveguide_types": {
            "_example_wg": {
                "_comment": "Define routing layer, default width, and min bend radius",
                "layer": 1,
                "default_width": 0.5,
                "min_bend_radius": 10
            },
            "Standard": {
                "layer": 1,
                "default_width": 0.5,
                "min_bend_radius": 10
            },
            "Wide": {
                "layer": 1,
                "default_width": 1.0,
                "min_bend_radius": 20
            }
        },
        
        "units": "um",
        "grid_resolution": 0.001
    }
    
    return jsonify({"template": template})


# Load custom PDKs from disk on startup
def load_custom_pdks():
    pdk_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "custom_pdks")
    if os.path.exists(pdk_dir):
        import json
        for filename in os.listdir(pdk_dir):
            if filename.endswith(".json"):
                pdk_id = filename[:-5]
                try:
                    with open(os.path.join(pdk_dir, filename), "r") as f:
                        CUSTOM_PDKS[pdk_id] = json.load(f)
                    print(f"[OK] Loaded custom PDK: {pdk_id}")
                except Exception as e:
                    print(f"[WARN] Failed to load PDK {filename}: {e}")

# Load on import
load_custom_pdks()


@app.route("/api/preview_gds", methods=["POST"])
def preview_gds():
    if not NAZCA_AVAILABLE:
        return jsonify({"error": "nazca not installed"}), 500
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400
    components = data.get("components", [])
    connections = data.get("connections", [])
    if not components:
        return jsonify({"error": "No components"}), 400
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt

        comp_map = {}
        tmpdir = tempfile.mkdtemp()
        top = nd.Cell("PREVIEW")
        with top:
            comp_dict = {c["id"]: c for c in components}

            for c in components:
                cell = build_cell(c["id"], c["type"], c["params"])
                x = round(float(c.get("x", 0)), 2)
                y = round(-float(c.get("y", 0)), 2)  # Y-flip for GDS
                rot = int(c.get("rotation", 0) or 0)
                
                # Negate rotation angle because:
                # - React uses screen coords (Y down) and rotates clockwise
                # - GDS uses math coords (Y up) and rotates counter-clockwise
                # - The Y-flip inverts the rotation direction
                gds_rot = -rot
                
                inst = cell.put(x, y, gds_rot)
                comp_map[c["id"]] = {"cell": cell, "inst": inst, "data": c}

            # Pin name mapping: React pin names -> nazca pin names
            # The pins rotate WITH the cell, so 'bottom' after 90° rotation
            # is still accessed as 'bottom' on the instance
            _pin_map = {
                "grating_coupler": {"wg_out": "a0", "gc_in": "a0"},
                "bond_pad": {"pad_l": "a0", "pad_r": "b0", "pad_t": "a1", "pad_b": "b1", "pad_a": "b1"},
            }
            def _rpin(cd, pn):
                ct = cd.get("type", "")
                return _pin_map.get(ct, {}).get(pn, pn)

            for cn in connections:
                fc_entry = comp_map.get(cn.get("fromComp"))
                tc_entry = comp_map.get(cn.get("toComp"))
                if not fc_entry or not tc_entry:
                    continue
                try:
                    # Get base pins from components
                    base_p1 = fc_entry["inst"].pin[_rpin(fc_entry["data"], cn.get("fromPin", "b0"))]
                    base_p2 = tc_entry["inst"].pin[_rpin(tc_entry["data"], cn.get("toPin", "a0"))]
                    
                    # Check for custom angles - if set, create new pins with those angles
                    from_angle = cn.get("fromAngle")
                    to_angle = cn.get("toAngle")
                    
                    if from_angle is not None:
                        # Create pin with custom angle (nazca angles are opposite to screen coords)
                        p1 = nd.Pin().put(base_p1.x, base_p1.y, -float(from_angle))
                    else:
                        p1 = base_p1
                    
                    if to_angle is not None:
                        p2 = nd.Pin().put(base_p2.x, base_p2.y, -float(to_angle))
                    else:
                        p2 = base_p2
                    
                    layer = cn.get("layer", "SiN")
                    ic_obj = ihp.IC_GM1 if layer == "GM1" else ihp.IC_SiNBWG
                    w = float(cn.get("width", 3.0 if layer == "GM1" else 0.7))
                    R = float(cn.get("radius", 100))
                    route = cn.get("routeType", "auto")
                    if route == "strt_p2p":
                        ic_obj.strt_p2p(pin1=p1, pin2=p2, width=w).put()
                    elif route == "ubend_p2p":
                        ic_obj.ubend_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                    elif route == "cobra_p2p":
                        ic_obj.cobra_p2p(pin1=p1, pin2=p2, width1=w, width2=w).put()
                    elif route == "bend_strt_bend_p2p":
                        ic_obj.bend_strt_bend_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                    elif route == "strt_bend_strt_p2p":
                        ic_obj.strt_bend_strt_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                    elif route == "sinebend_p2p":
                        ic_obj.sinebend_p2p(pin1=p1, pin2=p2, width=w).put()
                    elif route == "pcurve_p2p":
                        ic_obj.pcurve_p2p(pin1=p1, pin2=p2, width=w).put()
                    elif route == "taper_p2p":
                        w2 = float(cn.get("width2", w))
                        ic_obj.taper_p2p(pin1=p1, pin2=p2, width1=w, width2=w2).put()
                    else:
                        ic_obj.sbend_p2p(pin1=p1, pin2=p2, radius=R, width=w).put()
                except Exception as route_err:
                    print(f"[WARN] preview_gds route failed: {route_err}")
                    pass

        png_path = os.path.join(tmpdir, "preview.png")
        gds_preview_path = os.path.join(tmpdir, "preview.gds")
        try:
            nd.export_gds(topcells=top, filename=gds_preview_path)
            fig = plt.figure(figsize=(14, 9), dpi=150)
            nd.export_plt(topcells=top)
            plt.savefig(png_path, dpi=150, bbox_inches='tight',
                       facecolor='white', edgecolor='none', pad_inches=0.1)
            plt.close('all')
        except Exception as e2:
            plt.close('all')
            return jsonify({"error": f"Matplotlib render failed: {e2}", "ok": False})

        import base64
        with open(png_path, 'rb') as f:
            img_data = base64.b64encode(f.read()).decode('utf-8')
        return jsonify({"image": img_data, "ok": True})

    except Exception as e:
        return jsonify({"error": str(e), "traceback": traceback.format_exc()}), 500


# ═══════════════════════════════════════════════════════════════════════════
#  FRONTEND SERVING - serves React app from App.jsx
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/')
def serve_frontend():
    # Find App.jsx in same directory as app.py
    app_jsx_path = os.path.join(os.path.dirname(__file__), 'App.jsx')
    
    if os.path.exists(app_jsx_path):
        with open(app_jsx_path, 'r', encoding='utf-8') as f:
            app_jsx = f.read()
    else:
        app_jsx = 'function App() { return React.createElement("div", null, "App.jsx not found at: " + "' + app_jsx_path.replace('\\', '\\\\') + '"); }'
    
    html = '''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Photonic IC Designer</title>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { overflow: hidden; background: #0d1117; }
        #root { width: 100vw; height: 100vh; }
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="text/babel">
''' + app_jsx + '''

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
    </script>
</body>
</html>'''
    return html


# ═════════════════════════════════════════════════════════════════════════════
#  GET POLYGONS - Extract actual polygons for KLayout-style view
# ═════════════════════════════════════════════════════════════════════════════

@app.route("/api/get_polygons", methods=["POST"])
def get_polygons():
    """
    Generate actual polygon data for components - used for KLayout-style view.
    Exports each component to GDS, then reads back polygons with gdstk.
    """
    if not NAZCA_AVAILABLE:
        return jsonify({"error": "Nazca not available"}), 400
    
    data = request.get_json()
    components = data.get("components", [])
    
    # Check if gdstk is available
    try:
        import gdstk
        HAS_GDSTK = True
    except ImportError:
        HAS_GDSTK = False
    
    if not HAS_GDSTK:
        return jsonify({"error": "gdstk not installed. Run: pip install gdstk"}), 400
    
    # IHP PDK layer numbers to names
    LAYER_NAMES = {
        119: "SiNWG", 109: "GM1", 78: "GRB", 79: "GRT", 
        89: "GPS", 97: "GCT", 234: "Alignment", 86: "SiWG",
        1: "SiNWG", 2: "GM1"
    }
    
    result_polygons = {}
    
    try:
        for comp in components:
            comp_id = comp.get("id")
            comp_type = comp.get("type")
            params = comp.get("params", {})
            
            try:
                # Reset nazca for each component
                nd.cfg.cellnames = {}
                
                # Build the component cell
                cell = build_cell(comp_id, comp_type, params)
                if cell is None:
                    result_polygons[comp_id] = {"polygons": [], "error": "Failed to build"}
                    continue
                
                # Export to temporary GDS
                with tempfile.NamedTemporaryFile(suffix='.gds', delete=False) as tmp:
                    tmp_path = tmp.name
                
                try:
                    nd.export_gds(topcells=cell, filename=tmp_path)
                    
                    # Read back with gdstk
                    lib = gdstk.read_gds(tmp_path)
                    
                    polygons = []
                    for gcell in lib.cells:
                        # Get all polygons
                        for poly in gcell.polygons:
                            layer = poly.layer
                            points = poly.points.tolist()
                            layer_name = LAYER_NAMES.get(layer, f"L{layer}")
                            
                            polygons.append({
                                "layer": layer,
                                "layer_name": layer_name,
                                "points": [[float(p[0]), float(p[1])] for p in points]
                            })
                        
                        # Get paths converted to polygons
                        for path in gcell.paths:
                            layer = path.layers[0] if path.layers else 1
                            try:
                                poly_pts = path.to_polygons()
                                for pp in poly_pts:
                                    pts = pp.points.tolist() if hasattr(pp, 'points') else pp.tolist()
                                    layer_name = LAYER_NAMES.get(layer, f"L{layer}")
                                    polygons.append({
                                        "layer": layer,
                                        "layer_name": layer_name,
                                        "points": [[float(p[0]), float(p[1])] for p in pts]
                                    })
                            except:
                                pass
                    
                    result_polygons[comp_id] = {
                        "polygons": polygons,
                        "count": len(polygons)
                    }
                    
                finally:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)
                        
            except Exception as e:
                result_polygons[comp_id] = {
                    "error": str(e),
                    "polygons": []
                }
        
        return jsonify({
            "success": True,
            "polygons": result_polygons
        })
        
    except Exception as e:
        return jsonify({"error": str(e), "traceback": traceback.format_exc()}), 500


# ═════════════════════════════════════════════════════════════════════════════
#  SINGLE COMPONENT POLYGON EXTRACTION - For real-time canvas preview
# ═════════════════════════════════════════════════════════════════════════════

# Polygon cache to avoid rebuilding same components
POLYGON_CACHE = {}

def get_polygon_cache_key(comp_type, params):
    """Generate cache key for component polygons."""
    import hashlib
    import json
    param_str = json.dumps(params, sort_keys=True)
    return hashlib.md5(f"{comp_type}:{param_str}".encode()).hexdigest()


@app.route("/api/component_polygons", methods=["POST"])
def component_polygons():
    """
    Get polygon data for a single component type with given params.
    Used for real-time polygon preview in the canvas.
    Returns polygon data with layer info and bounding box.
    """
    if not NAZCA_AVAILABLE:
        return jsonify({"error": "Nazca not available"}), 400
    
    # Check if gdstk is available
    try:
        import gdstk
    except ImportError:
        return jsonify({"error": "gdstk not installed. Run: pip install gdstk"}), 400
    
    data = request.get_json()
    comp_type = data.get("type")
    params = data.get("params", {})
    comp_id = data.get("id", "preview")
    
    if not comp_type:
        return jsonify({"error": "Component type required"}), 400
    
    # Check cache
    cache_key = get_polygon_cache_key(comp_type, params)
    if cache_key in POLYGON_CACHE:
        cached = POLYGON_CACHE[cache_key]
        return jsonify({
            "polygons": cached["polygons"],
            "bbox": cached["bbox"],
            "count": cached["count"],
            "pins": cached.get("pins", {}),
            "primary_pin": cached.get("primary_pin", {"x": 0, "y": 0}),
            "cached": True
        })
    
    # IHP PDK layer numbers to colors
    LAYER_COLORS = {
        119: {"color": "#1565c0", "name": "SiNWG", "opacity": 0.85},
        109: {"color": "#e65100", "name": "GM1", "opacity": 0.80},
        78:  {"color": "#c62828", "name": "GRB", "opacity": 0.75},
        79:  {"color": "#2e7d32", "name": "GRT", "opacity": 0.75},
        89:  {"color": "#f9a825", "name": "GPS", "opacity": 0.45},
        97:  {"color": "#795548", "name": "GCT", "opacity": 0.70},
        85:  {"color": "#7b1fa2", "name": "VIA", "opacity": 0.90},
        86:  {"color": "#0277bd", "name": "SiWG", "opacity": 0.85},
        234: {"color": "#546e7a", "name": "Alignment", "opacity": 0.50},
        1:   {"color": "#1565c0", "name": "SiNWG", "opacity": 0.85},
        2:   {"color": "#e65100", "name": "GM1", "opacity": 0.80},
    }
    
    try:
        # Reset nazca cell names to avoid conflicts
        nd.cfg.cellnames = {}
        
        # Build the component
        cell = build_cell(f"poly_{comp_id}_{cache_key[:6]}", comp_type, params)
        
        if cell is None:
            return jsonify({"error": "Failed to build component"}), 400
        
        # Extract pin positions from nazca cell BEFORE exporting
        pins = {}
        try:
            for pin_name in cell.pin:
                pin = cell.pin[pin_name]
                pins[pin_name] = {
                    "x": float(pin.xya()[0]),
                    "y": float(pin.xya()[1]),
                    "a": float(pin.xya()[2])  # angle
                }
            print(f"[DEBUG] {comp_type} pins: {pins}")
        except Exception as e:
            print(f"[WARN] Could not extract pins: {e}")
        
        # The icon renderers use the left edge of the component body as origin (0,0)
        # NOT the a0 pin position. So we use (0,0) as the primary reference point.
        primary_pin_pos = {"x": 0, "y": 0}
        
        # Export to temporary GDS
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
                        pass
            
            # Calculate bounding box
            all_x = []
            all_y = []
            for poly in polygons:
                for pt in poly["points"]:
                    all_x.append(pt[0])
                    all_y.append(pt[1])
            
            if all_x and all_y:
                bbox = {
                    "x_min": min(all_x),
                    "x_max": max(all_x),
                    "y_min": min(all_y),
                    "y_max": max(all_y),
                    "width": max(all_x) - min(all_x),
                    "height": max(all_y) - min(all_y)
                }
            else:
                bbox = {"x_min": 0, "x_max": 100, "y_min": 0, "y_max": 100, "width": 100, "height": 100}
            
            result = {
                "polygons": polygons,
                "bbox": bbox,
                "count": len(polygons),
                "pins": pins,
                "primary_pin": primary_pin_pos  # Where the primary pin is in GDS coords
            }
            
            # Cache the result (limit cache size)
            if len(POLYGON_CACHE) > 100:
                # Remove oldest entries
                oldest_keys = list(POLYGON_CACHE.keys())[:20]
                for k in oldest_keys:
                    del POLYGON_CACHE[k]
            
            POLYGON_CACHE[cache_key] = result
            
            return jsonify(result)
            
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
                
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ═════════════════════════════════════════════════════════════════════════════
#  CONNECTION POLYGONS - Get waveguide route polygons for canvas preview
# ═════════════════════════════════════════════════════════════════════════════

CONNECTION_POLYGON_CACHE = {}

@app.route("/api/connection_polygons", methods=["POST"])
def connection_polygons():
    """
    Get polygon data for a waveguide connection/route.
    Takes start point, end point, route type, layer, and returns polygons.
    """
    if not NAZCA_AVAILABLE:
        return jsonify({"error": "Nazca not available"}), 400
    
    try:
        import gdstk
    except ImportError:
        return jsonify({"error": "gdstk not installed"}), 400
    
    data = request.get_json()
    x1 = float(data.get("x1", 0))
    y1 = float(data.get("y1", 0))
    x2 = float(data.get("x2", 100))
    y2 = float(data.get("y2", 0))
    route_type = data.get("routeType", "sbend_p2p")
    layer = data.get("layer", "SiN")  # SiN or GM1
    width = float(data.get("width", 0.7 if layer == "SiN" else 3.0))
    radius = float(data.get("radius", 100))
    conn_id = data.get("id", "conn")
    
    # Create cache key
    cache_key = f"{x1:.2f}_{y1:.2f}_{x2:.2f}_{y2:.2f}_{route_type}_{layer}_{width}_{radius}"
    
    if cache_key in CONNECTION_POLYGON_CACHE:
        return jsonify(CONNECTION_POLYGON_CACHE[cache_key])
    
    try:
        nd.cfg.cellnames = {}
        
        # Get the appropriate interconnect object
        L = _pdk()
        ic_obj = L.gm1 if layer == "GM1" else L.wg
        
        # Calculate angle from p1 to p2 for proper pin orientation
        import math
        angle1 = math.degrees(math.atan2(y2 - y1, x2 - x1))  # Angle pointing TO p2
        angle2 = angle1 + 180  # Angle pointing back TO p1
        
        with nd.Cell(f"CONN_{conn_id}") as C:
            # Create pins at start and end points with proper angles
            p1 = nd.Pin("start").put(x1, y1, angle1)
            p2 = nd.Pin("end").put(x2, y2, angle2)
            
            # Route based on type
            try:
                if route_type == "strt_p2p":
                    ic_obj.strt_p2p(pin1=p1, pin2=p2, width=width).put()
                elif route_type == "sbend_p2p":
                    ic_obj.sbend_p2p(pin1=p1, pin2=p2, width=width).put()
                elif route_type == "ubend_p2p":
                    ic_obj.ubend_p2p(pin1=p1, pin2=p2, width=width, radius=radius).put()
                elif route_type == "bend_strt_bend_p2p":
                    ic_obj.bend_strt_bend_p2p(pin1=p1, pin2=p2, radius=radius, width=width).put()
                elif route_type == "strt_bend_strt_p2p":
                    ic_obj.strt_bend_strt_p2p(pin1=p1, pin2=p2, radius=radius, width=width).put()
                elif route_type == "cobra_p2p":
                    ic_obj.cobra_p2p(pin1=p1, pin2=p2, width1=width, width2=width).put()
                elif route_type == "pcurve_p2p":
                    ic_obj.pcurve_p2p(pin1=p1, pin2=p2, width=width).put()
                elif route_type == "sinebend_p2p":
                    ic_obj.sinebend_p2p(pin1=p1, pin2=p2, width=width).put()
                elif route_type == "taper_p2p":
                    width2 = float(data.get("width2", width))
                    ic_obj.taper_p2p(pin1=p1, pin2=p2, width1=width, width2=width2).put()
                else:
                    # Default to sbend
                    ic_obj.sbend_p2p(pin1=p1, pin2=p2, width=width).put()
            except Exception as route_err:
                print(f"[WARN] Route {route_type} failed: {route_err}, falling back to strt_p2p")
                try:
                    ic_obj.strt_p2p(pin1=p1, pin2=p2, width=width).put()
                except Exception as e2:
                    print(f"[ERROR] strt_p2p also failed: {e2}")
            
            nd.put_stub()
        
        # Export to GDS and extract polygons
        with tempfile.NamedTemporaryFile(suffix='.gds', delete=False) as tmp:
            tmp_path = tmp.name
        
        try:
            nd.export_gds(topcells=C, filename=tmp_path)
            lib = gdstk.read_gds(tmp_path)
            
            polygons = []
            for gcell in lib.cells:
                for poly in gcell.polygons:
                    layer_num = int(poly.layer)
                    points = poly.points.tolist()
                    
                    polygons.append({
                        "layer": layer_num,
                        "points": [[float(p[0]), float(p[1])] for p in points]
                    })
                
                # Convert paths to polygons
                for path in gcell.paths:
                    layer_num = path.layers[0] if path.layers else 119
                    try:
                        poly_pts = path.to_polygons()
                        for pp in poly_pts:
                            pts = pp.points.tolist() if hasattr(pp, 'points') else pp.tolist()
                            polygons.append({
                                "layer": layer_num,
                                "points": [[float(p[0]), float(p[1])] for p in pts]
                            })
                    except:
                        pass
            
            # Calculate bbox
            all_x, all_y = [], []
            for poly in polygons:
                for pt in poly["points"]:
                    all_x.append(pt[0])
                    all_y.append(pt[1])
            
            bbox = {
                "x_min": min(all_x) if all_x else x1,
                "x_max": max(all_x) if all_x else x2,
                "y_min": min(all_y) if all_y else min(y1, y2) - 1,
                "y_max": max(all_y) if all_y else max(y1, y2) + 1
            }
            
            result = {
                "polygons": polygons,
                "bbox": bbox,
                "count": len(polygons)
            }
            
            print(f"[CONN] Generated {len(polygons)} polygons for connection from ({x1:.1f},{y1:.1f}) to ({x2:.1f},{y2:.1f})")
            
            # Cache result
            if len(CONNECTION_POLYGON_CACHE) > 200:
                # Clear oldest entries
                oldest = list(CONNECTION_POLYGON_CACHE.keys())[:50]
                for k in oldest:
                    del CONNECTION_POLYGON_CACHE[k]
            
            CONNECTION_POLYGON_CACHE[cache_key] = result
            
            return jsonify(result)
            
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
                
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ═════════════════════════════════════════════════════════════════════════════
#  GDS IMPORT - Parse GDS and extract components
# ═════════════════════════════════════════════════════════════════════════════

@app.route("/api/import_gds", methods=["POST"])
def import_gds():
    """
    Import a GDS or OAS (OASIS) file and extract components/polygons for editing.
    Uses gdstk or klayout.db for proper polygon extraction.
    Supported formats: .gds, .gds2, .oas, .oasis
    """
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    
    filename_lower = file.filename.lower()
    is_gds = filename_lower.endswith('.gds') or filename_lower.endswith('.gds2')
    is_oas = filename_lower.endswith('.oas') or filename_lower.endswith('.oasis')
    
    if not is_gds and not is_oas:
        return jsonify({"error": "File must be a .gds, .gds2, .oas, or .oasis file"}), 400
    
    file_format = "oas" if is_oas else "gds"
    file_suffix = '.oas' if is_oas else '.gds'
    
    try:
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(suffix=file_suffix, delete=False) as tmp:
            file.save(tmp.name)
            tmp_path = tmp.name
        
        components = []
        comp_id = 0
        
        # Try gdstk first (faster, commonly installed)
        try:
            import gdstk
            # gdstk can read both GDS and OAS formats
            if is_oas:
                lib = gdstk.read_oas(tmp_path)
            else:
                lib = gdstk.read_gds(tmp_path)
            
            # Find the top-level cell (usually last one, or one with no references to it, or named 'nazca'/'top')
            top_cell = None
            for cell in lib.cells:
                if cell.name.lower() in ['nazca', 'top', 'main', 'topcell']:
                    top_cell = cell
                    break
            if top_cell is None and lib.cells:
                # Use the last cell as top
                top_cell = lib.cells[-1]
            
            if top_cell is None:
                os.unlink(tmp_path)
                return jsonify({"error": "No cells found in GDS"}), 400
            
            # Flatten the top cell to get all polygons including from references
            # This creates a copy with all references expanded
            flat_cell = top_cell.copy(f"{top_cell.name}_flat")
            flat_cell.flatten()
            
            # Get bounding box of flattened cell
            bbox = flat_cell.bounding_box()
            if bbox is not None:
                x_min, y_min = bbox[0]
                x_max, y_max = bbox[1]
            else:
                x_min, y_min, x_max, y_max = 0, 0, 100, 100
            
            width = x_max - x_min
            height = y_max - y_min
            
            # Extract ALL polygons from flattened cell
            all_polygons = []
            for poly in flat_cell.polygons:
                layer = poly.layer
                # Skip annotation/helper layers
                if layer >= 1000:
                    continue
                pts = poly.points.tolist()
                all_polygons.append({
                    "layer": int(layer),
                    "points": [[float(p[0]), float(p[1])] for p in pts]
                })
            
            # Also get paths as polygons
            for path in flat_cell.paths:
                layer = path.layers[0] if path.layers else 0
                if layer >= 1000:
                    continue
                # Convert path to polygon
                poly_pts = path.to_polygons()
                for pp in poly_pts:
                    pts = pp.points.tolist() if hasattr(pp, 'points') else pp.tolist()
                    all_polygons.append({
                        "layer": int(layer),
                        "points": [[float(p[0]), float(p[1])] for p in pts]
                    })
            
            os.unlink(tmp_path)
            
            if not all_polygons:
                return jsonify({"error": "No polygons found in GDS"}), 400
            
            # Create a single imported component with all the polygons
            # Position at origin, let user move it
            components.append({
                "id": f"imp_0",
                "type": "imported_gds",
                "original_name": top_cell.name,
                "x": 0,
                "y": 0,
                "rotation": 0,
                "width": float(width),
                "height": float(height),
                "bbox": {
                    "x_min": float(x_min),
                    "y_min": float(y_min),
                    "x_max": float(x_max),
                    "y_max": float(y_max)
                },
                "polygons": all_polygons,
                "params": {
                    "imported": True,
                    "original_cell": top_cell.name,
                    "polygon_count": len(all_polygons)
                }
            })
            
            return jsonify({
                "success": True,
                "components": components,
                "message": f"Imported {len(all_polygons)} polygons from '{top_cell.name}'"
            })
            
        except ImportError:
            pass  # gdstk not available, try klayout
        
        # Try klayout.db
        try:
            import klayout.db as db
            layout = db.Layout()
            layout.read(tmp_path)
            
            for cell_idx in layout.each_cell():
                cell = layout.cell(cell_idx)
                cell_name = cell.name
                if cell_name.startswith('$') or cell_name.startswith('_'):
                    continue
                
                bbox = cell.bbox()
                if bbox:
                    x_min = bbox.left * layout.dbu
                    y_min = bbox.bottom * layout.dbu
                    x_max = bbox.right * layout.dbu
                    y_max = bbox.top * layout.dbu
                else:
                    x_min, y_min, x_max, y_max = 0, 0, 100, 100
                
                width = x_max - x_min
                height = y_max - y_min
                center_x = (x_min + x_max) / 2
                center_y = (y_min + y_max) / 2
                
                # Extract polygons from all layers
                all_polygons = []
                for layer_idx in layout.layer_indexes():
                    layer_info = layout.get_info(layer_idx)
                    layer_num = layer_info.layer
                    
                    for shape in cell.shapes(layer_idx).each():
                        if shape.is_polygon() or shape.is_box() or shape.is_path():
                            poly = shape.polygon
                            pts = []
                            for pt in poly.each_point_hull():
                                pts.append([float(pt.x * layout.dbu), float(pt.y * layout.dbu)])
                            if pts:
                                all_polygons.append({
                                    "layer": int(layer_num),
                                    "points": pts
                                })
                
                comp_type = "custom_polygon"
                name_lower = cell_name.lower()
                if "gc" in name_lower or "grating" in name_lower:
                    comp_type = "grating_coupler"
                elif "eam" in name_lower:
                    comp_type = "straight_eam"
                elif "ring" in name_lower:
                    comp_type = "ring_resonator"
                
                components.append({
                    "id": f"imp_{comp_id}",
                    "type": comp_type,
                    "original_name": cell_name,
                    "x": float(center_x),
                    "y": float(-center_y),
                    "rotation": 0,
                    "width": float(width),
                    "height": float(height),
                    "polygons": all_polygons[:100],
                    "params": {
                        "imported": True,
                        "original_cell": cell_name
                    }
                })
                comp_id += 1
            
            os.unlink(tmp_path)
            
            if not components:
                return jsonify({"error": "No cells found in GDS"}), 400
            
            return jsonify({
                "success": True,
                "components": components,
                "message": f"Imported {len(components)} cell(s) via klayout"
            })
            
        except ImportError:
            pass  # klayout not available
        
        # Fallback: basic nazca import (no polygon details)
        if NAZCA_AVAILABLE:
            try:
                nd.cfg.cellnames = {}
                loaded = nd.load_gds(filename=tmp_path, cellname=None, newcellname=None,
                                      instantiate=False, native=True)
                
                all_cells = []
                if loaded:
                    all_cells = list(loaded) if isinstance(loaded, (list, tuple)) else [loaded]
                
                for cell in all_cells:
                    if cell is None:
                        continue
                    cell_name = str(cell.cell_name) if hasattr(cell, 'cell_name') else f"cell_{comp_id}"
                    if cell_name.startswith('$') or cell_name.startswith('_'):
                        continue
                    
                    bbox = getattr(cell, 'bbox', None)
                    if bbox and len(bbox) >= 4:
                        x_min, y_min, x_max, y_max = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
                    else:
                        x_min, y_min, x_max, y_max = 0, 0, 100, 100
                    
                    components.append({
                        "id": f"imp_{comp_id}",
                        "type": "custom_polygon",
                        "original_name": cell_name,
                        "x": float((x_min + x_max) / 2),
                        "y": float(-(y_min + y_max) / 2),
                        "rotation": 0,
                        "width": float(x_max - x_min),
                        "height": float(y_max - y_min),
                        "polygons": [],
                        "params": {"imported": True, "original_cell": cell_name}
                    })
                    comp_id += 1
                
                os.unlink(tmp_path)
                
                if components:
                    return jsonify({
                        "success": True,
                        "components": components,
                        "message": f"Imported {len(components)} cell(s) (basic mode - install gdstk for full geometry)"
                    })
            except Exception as e:
                traceback.print_exc()
        
        os.unlink(tmp_path)
        return jsonify({"error": "No GDS parsing library available. Install gdstk: pip install gdstk"}), 500
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ═════════════════════════════════════════════════════════════════════════════
#  CUSTOM PDK SYSTEM
# ═════════════════════════════════════════════════════════════════════════════

class CustomPDK:
    """Load and manage custom PDK definitions from JSON files."""
    
    def __init__(self, pdk_path=None):
        self.pdk_path = pdk_path
        self.config = {}
        self.layers = {}
        self.rules = {}
        self.components = {}
        self.loaded = False
        
        if pdk_path and os.path.exists(pdk_path):
            self.load_pdk()
    
    def load_pdk(self):
        """Load PDK from directory containing JSON config files."""
        try:
            # Try loading main config
            config_path = os.path.join(self.pdk_path, "pdk_config.json")
            if os.path.exists(config_path):
                with open(config_path, 'r') as f:
                    self.config = json.load(f)
            
            # Load layers
            layers_file = self.config.get("files", {}).get("layers", "layers.json")
            layers_path = os.path.join(self.pdk_path, layers_file)
            if os.path.exists(layers_path):
                with open(layers_path, 'r') as f:
                    data = json.load(f)
                    self.layers = data.get("layers", data)
            
            # Load design rules
            rules_file = self.config.get("files", {}).get("design_rules", "design_rules.json")
            rules_path = os.path.join(self.pdk_path, rules_file)
            if os.path.exists(rules_path):
                with open(rules_path, 'r') as f:
                    self.rules = json.load(f)
            
            # Load component definitions
            comp_files = self.config.get("files", {}).get("components", [])
            if isinstance(comp_files, str):
                comp_files = [comp_files]
            
            for comp_file in comp_files:
                comp_path = os.path.join(self.pdk_path, comp_file)
                if os.path.exists(comp_path):
                    with open(comp_path, 'r') as f:
                        comp_data = json.load(f)
                        for comp_id, comp_def in comp_data.get("components", {}).items():
                            comp_def["_category"] = comp_data.get("category", "Custom")
                            self.components[comp_id] = comp_def
            
            self.loaded = True
            print(f"[PDK] Loaded: {self.config.get('pdk_name', 'Custom PDK')}")
            print(f"      Layers: {len(self.layers)}, Components: {len(self.components)}")
            return True
            
        except Exception as e:
            print(f"[PDK] Load error: {e}")
            return False
    
    def get_layer_info(self, layer_name):
        """Get layer info by name."""
        return self.layers.get(layer_name, {})
    
    def get_layer_number(self, layer_name):
        """Get GDS layer number."""
        return self.layers.get(layer_name, {}).get("number", 0)
    
    def get_layer_color(self, layer_name):
        """Get display color for layer."""
        return self.layers.get(layer_name, {}).get("color", "#888888")
    
    def get_all_layers(self):
        """Get all layer definitions."""
        return self.layers
    
    def get_rule(self, layer_name, rule_type):
        """Get specific design rule for a layer."""
        layer_rules = self.rules.get("rules", {}).get(layer_name, {})
        return layer_rules.get(rule_type)
    
    def check_drc(self, layer_name, width=None, space=None, area=None):
        """Check dimensions against design rules."""
        rule = self.rules.get("rules", {}).get(layer_name, {})
        violations = []
        
        if width is not None:
            if "min_width" in rule and width < rule["min_width"]:
                violations.append({
                    "rule": f"{layer_name}.min_width",
                    "message": f"Width {width}µm < min {rule['min_width']}µm",
                    "severity": "error"
                })
            if "max_width" in rule and width > rule["max_width"]:
                violations.append({
                    "rule": f"{layer_name}.max_width",
                    "message": f"Width {width}µm > max {rule['max_width']}µm",
                    "severity": "warning"
                })
            if "exact_width" in rule and abs(width - rule["exact_width"]) > 0.001:
                violations.append({
                    "rule": f"{layer_name}.exact_width",
                    "message": f"Width {width}µm ≠ required {rule['exact_width']}µm",
                    "severity": "error"
                })
        
        if space is not None and "min_space" in rule:
            if space < rule["min_space"]:
                violations.append({
                    "rule": f"{layer_name}.min_space",
                    "message": f"Space {space}µm < min {rule['min_space']}µm",
                    "severity": "error"
                })
        
        if area is not None and "min_area" in rule:
            if area < rule["min_area"]:
                violations.append({
                    "rule": f"{layer_name}.min_area",
                    "message": f"Area {area}µm² < min {rule['min_area']}µm²",
                    "severity": "warning"
                })
        
        return violations
    
    def get_component_def(self, comp_type):
        """Get component definition."""
        return self.components.get(comp_type)
    
    def list_components(self):
        """List all available components grouped by category."""
        categories = {}
        for comp_id, comp_def in self.components.items():
            cat = comp_def.get("_category", "Other")
            if cat not in categories:
                categories[cat] = []
            categories[cat].append({
                "id": comp_id,
                "name": comp_def.get("name", comp_id),
                "icon": comp_def.get("icon", "□"),
                "description": comp_def.get("description", "")
            })
        return categories
    
    def to_dict(self):
        """Export PDK as dictionary (for API responses)."""
        return {
            "config": self.config,
            "layers": self.layers,
            "rules": self.rules,
            "components": {k: {
                "name": v.get("name"),
                "icon": v.get("icon"),
                "description": v.get("description"),
                "category": v.get("_category"),
                "parameters": v.get("parameters", {}),
                "pins": v.get("pins", {})
            } for k, v in self.components.items()},
            "loaded": self.loaded
        }


# Global PDK instance (default: IHP)
current_pdk = None


@app.route("/api/pdk/load", methods=["POST"])
def load_pdk():
    """Load a custom PDK from a directory path."""
    global current_pdk
    
    data = request.get_json()
    pdk_path = data.get("path", "")
    
    if not pdk_path:
        return jsonify({"error": "No PDK path provided"}), 400
    
    if not os.path.exists(pdk_path):
        return jsonify({"error": f"PDK path not found: {pdk_path}"}), 404
    
    try:
        current_pdk = CustomPDK(pdk_path)
        if current_pdk.loaded:
            return jsonify({
                "ok": True,
                "pdk": current_pdk.to_dict(),
                "message": f"Loaded {current_pdk.config.get('pdk_name', 'Custom PDK')}"
            })
        else:
            return jsonify({"error": "Failed to load PDK"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pdk/current", methods=["GET"])
def get_current_pdk():
    """Get the currently loaded PDK definition."""
    if current_pdk and current_pdk.loaded:
        return jsonify(current_pdk.to_dict())
    else:
        # Return built-in IHP PDK info
        return jsonify({
            "config": {
                "pdk_name": "IHP SiN + Graphene",
                "pdk_id": "ihp_sin_graphene",
                "version": "1.0",
                "foundry": "IHP GmbH"
            },
            "layers": DRC_LAYERS,
            "rules": DRC_RULES,
            "loaded": True,
            "builtin": True
        })


@app.route("/api/pdk/layers", methods=["GET"])
def get_pdk_layers():
    """Get all layer definitions from current PDK."""
    if current_pdk and current_pdk.loaded:
        return jsonify(current_pdk.get_all_layers())
    else:
        # Built-in IHP layers
        return jsonify({
            78: {"number": 78, "name": "GraphBot", "color": "#4caf50"},
            79: {"number": 79, "name": "GraphTop", "color": "#8bc34a"},
            85: {"number": 85, "name": "GraphCont", "color": "#9c27b0"},
            86: {"number": 86, "name": "SiWG", "color": "#ff5722"},
            87: {"number": 87, "name": "SiGrating", "color": "#795548"},
            88: {"number": 88, "name": "SiNGrating", "color": "#607d8b"},
            89: {"number": 89, "name": "GraphPass", "color": "#00bcd4"},
            97: {"number": 97, "name": "GraphPAD", "color": "#ff9800"},
            109: {"number": 109, "name": "GraphMet1", "color": "#ffc107"},
            110: {"number": 110, "name": "GraphMet1L", "color": "#ffeb3b"},
            118: {"number": 118, "name": "GraphGat", "color": "#e91e63"},
            119: {"number": 119, "name": "SiNWG", "color": "#2196f3"}
        })


@app.route("/api/pdk/components", methods=["GET"])
def get_pdk_components():
    """Get all component definitions from current PDK."""
    if current_pdk and current_pdk.loaded:
        return jsonify(current_pdk.list_components())
    else:
        return jsonify({"message": "Using built-in components"})


@app.route("/api/pdk/check_rule", methods=["POST"])
def check_pdk_rule():
    """Check a specific dimension against PDK rules."""
    data = request.get_json()
    layer = data.get("layer", "SiNWG")
    width = data.get("width")
    space = data.get("space")
    area = data.get("area")
    
    if current_pdk and current_pdk.loaded:
        violations = current_pdk.check_drc(layer, width, space, area)
    else:
        # Use built-in DRC
        violations = []
        rule = DRC_RULES.get("rules", {}).get(layer, {})
        # ... similar logic as CustomPDK.check_drc
    
    return jsonify({
        "layer": layer,
        "violations": violations,
        "ok": len(violations) == 0
    })


@app.route("/api/pdk/create_template", methods=["GET"])
def create_pdk_template():
    """Generate a template PDK structure that users can customize."""
    template = {
        "pdk_config.json": {
            "pdk_name": "My Custom PDK",
            "pdk_id": "my_custom_pdk",
            "version": "1.0.0",
            "foundry": "My Foundry",
            "technology": "Silicon Photonics",
            "files": {
                "layers": "layers.json",
                "design_rules": "design_rules.json",
                "components": ["components/waveguides.json"]
            },
            "defaults": {
                "grid_um": 0.001,
                "waveguide_layer": "WG",
                "waveguide_width": 0.5
            }
        },
        "layers.json": {
            "pdk_name": "My Custom PDK",
            "layers": {
                "WG": {
                    "number": 1,
                    "datatype": 0,
                    "name": "Waveguide",
                    "color": "#2196f3",
                    "description": "Main waveguide layer"
                },
                "METAL": {
                    "number": 10,
                    "datatype": 0,
                    "name": "Metal",
                    "color": "#ffc107",
                    "description": "Metal routing"
                }
            }
        },
        "design_rules.json": {
            "pdk_name": "My Custom PDK",
            "units": "um",
            "rules": {
                "WG": {
                    "min_width": 0.2,
                    "min_space": 0.2,
                    "min_area": 1.0
                },
                "METAL": {
                    "min_width": 1.0,
                    "min_space": 1.0
                }
            }
        },
        "components/waveguides.json": {
            "category": "Waveguides",
            "components": {
                "straight": {
                    "name": "Straight Waveguide",
                    "icon": "━",
                    "description": "Straight waveguide section",
                    "parameters": {
                        "length": {"default": 100, "min": 1, "max": 10000, "unit": "um"},
                        "width": {"default": 0.5, "min": 0.2, "max": 10, "unit": "um"}
                    },
                    "pins": {
                        "a0": {"x": 0, "y": 0, "angle": 180},
                        "b0": {"x": "length", "y": 0, "angle": 0}
                    }
                }
            }
        }
    }
    
    return jsonify({
        "template": template,
        "instructions": [
            "1. Create a folder for your PDK (e.g., 'my_pdk/')",
            "2. Save each JSON file in the template to the folder",
            "3. Customize layers, rules, and components",
            "4. Load with: POST /api/pdk/load {path: 'my_pdk/'}"
        ]
    })


# Import json for PDK system
import json


if __name__ == "__main__":
    print(f"\n  Photonic Designer Backend")
    print(f"  nazca available: {NAZCA_AVAILABLE}")
    print(f"  http://localhost:5000\n")
    app.run(debug=True, port=5000)