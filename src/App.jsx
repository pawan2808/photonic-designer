// App.jsx — Photonic IC Layout Designer v3 (Clean Rewrite)
// PIN-CENTERED COORDINATE SYSTEM:
//   comp.x, comp.y = position of primary waveguide pin (µm)
//   All rendering relative to that pin
//   GDS: x_gds = comp.x, y_gds = -comp.y (direct, no offset)
//   Rotation: SVG <g transform="rotate(deg)"> around pin origin
const { useState, useRef, useCallback, useEffect } = React;
const API = "http://localhost:5000/api";
const LAYERS = {
  SiN:{color:"#1976d2",op:0.92}, GRT:{color:"#2e7d32",op:0.85},
  GRB:{color:"#c62828",op:0.85}, GPS:{color:"#f9a825",op:0.45},
  GM1:{color:"#e65100",op:0.90}, GCT:{color:"#795548",op:0.85},
  VIA:{color:"#7b1fa2",op:1.0},  PAD:{color:"#00695c",op:0.90},
};
const CL={SiN:{label:"SiN WG",color:"#1976d2"},GM1:{label:"Metal GM1",color:"#e65100"}};
const RT={
  auto:{label:"Auto (S-bend)",n:"sbend_p2p"},
  strt_p2p:{label:"Straight",n:"strt_p2p"},
  sbend_p2p:{label:"S-bend",n:"sbend_p2p"},
  cobra_p2p:{label:"Cobra",n:"cobra_p2p"},
  bend_strt_bend_p2p:{label:"Bend-Strt-Bend",n:"bend_strt_bend_p2p"},
  ubend_p2p:{label:"U-bend",n:"ubend_p2p"},
  sinebend_p2p:{label:"Sine bend",n:"sinebend"},
  strt_bend_strt_p2p:{label:"Strt-Bend-Strt",n:"strt_bend_strt_p2p"},
  taper_p2p:{label:"Taper",n:"taper_p2p"},
  pcurve_p2p:{label:"P-curve",n:"pcurve_p2p"},
};
const BS=2, RSZ=36;
const GRID_OPTIONS=[0.01,0.02,0.05,0.1,0.2,0.5,1,2,5,10,20,50];

// ═══ IHP PDK LAYER COLORS (exact match from KLayout .lyp) ═══
// pattern: 'solid', 'hatch', 'dots', 'diagonal', 'cross'
const DEFAULT_LAYER_COLORS = {
  // SiN Waveguide - Blue (119/0)
  119: { name: "SiNWG", color: "#0000ff", opacity: 0.75, pattern: "solid" },
  // Si Waveguide - Blue (86/0)
  86: { name: "SiWG", color: "#0000ff", opacity: 0.7, pattern: "hatch" },
  // GraphBot (Graphene Bottom) - Red (78/0)
  78: { name: "GraphBot", color: "#ff0000", opacity: 0.7, pattern: "diagonal" },
  // GraphTop (Graphene Top) - Red (79/0)
  79: { name: "GraphTop", color: "#ff0000", opacity: 0.65, pattern: "dots" },
  // GraphCont (Via/Contact) - Yellow-Green (85/0)
  85: { name: "GraphCont", color: "#ddff00", opacity: 0.8, pattern: "solid" },
  // SiNGrating - Cyan (88/0)
  88: { name: "SiNGrating", color: "#80fffb", opacity: 0.7, pattern: "hatch" },
  // SiGrating - Cyan (87/0)
  87: { name: "SiGrating", color: "#80fffb", opacity: 0.7, pattern: "hatch" },
  // GraphPass (Passivation) - Green (89/0)
  89: { name: "GraphPass", color: "#01ff6b", opacity: 0.7, pattern: "cross" },
  // GraphPAD - Orange (97/0)
  97: { name: "GraphPAD", color: "#ff8000", opacity: 0.8, pattern: "solid" },
  // GraphMetal1 (GM1) - Orange/Gold (109/0)
  109: { name: "GraphMetal1", color: "#ffae00", opacity: 0.8, pattern: "solid" },
  // GraphMetal1L (Top metal) - Teal (110/0)
  110: { name: "GraphMet1L", color: "#008050", opacity: 0.75, pattern: "hatch" },
  // GraphGate - Red (118/0)
  118: { name: "GraphGate", color: "#ff0000", opacity: 0.6, pattern: "cross" },
  // Alignment - Cyan (234/0)
  234: { name: "Alignment", color: "#80fffb", opacity: 0.5, pattern: "dots" },
};

// This will be used as a getter function that returns the current layer colors
let POLY_LAYER_COLORS = { ...DEFAULT_LAYER_COLORS };

// SVG pattern definitions for layer fill
const LayerPatternDefs = () => (
  <defs>
    {/* Diagonal lines pattern */}
    <pattern id="pattern-diagonal" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.7"/>
    </pattern>
    {/* Horizontal hatch pattern */}
    <pattern id="pattern-hatch" patternUnits="userSpaceOnUse" width="5" height="5">
      <line x1="0" y1="2.5" x2="5" y2="2.5" stroke="currentColor" strokeWidth="1" strokeOpacity="0.6"/>
    </pattern>
    {/* Dots pattern */}
    <pattern id="pattern-dots" patternUnits="userSpaceOnUse" width="5" height="5">
      <circle cx="2.5" cy="2.5" r="1" fill="currentColor" fillOpacity="0.6"/>
    </pattern>
    {/* Cross hatch pattern */}
    <pattern id="pattern-cross" patternUnits="userSpaceOnUse" width="6" height="6">
      <line x1="0" y1="3" x2="6" y2="3" stroke="currentColor" strokeWidth="0.8" strokeOpacity="0.5"/>
      <line x1="3" y1="0" x2="3" y2="6" stroke="currentColor" strokeWidth="0.8" strokeOpacity="0.5"/>
    </pattern>
  </defs>
);

// Polygon cache to avoid repeated API calls
const polygonCache = new Map();

// ═══ REAL POLYGON RENDERER ═══
// The component's placement point (comp.x, comp.y) corresponds to the GDS a0 pin.
// For GratingCoupler: a0 is at the narrow end (waveguide connection) per IHP PDK.
// No rotation offset needed since we use a0 as anchor.

const RealPolygonRenderer = React.memo(function RealPolygonRenderer({ polygons, bbox, pins, scale, selected, darkMode, rotation = 0, componentType = '', highlightLayer = null, hiddenLayers = new Set() }) {
  if (!polygons || polygons.length === 0) return null;
  
  // Filter out hidden layers
  const visiblePolygons = polygons.filter(poly => !hiddenLayers.has(poly.layer));
  if (visiblePolygons.length === 0) return null;
  
  // Use provided bbox
  let minX = bbox?.x_min ?? 0;
  let minY = bbox?.y_min ?? 0;
  let maxX = bbox?.x_max ?? 0;
  let maxY = bbox?.y_max ?? 0;
  
  const width = maxX - minX;
  const height = maxY - minY;
  const margin = 4;
  const S = scale;
  
  // SVG size
  const svgW = width * S + margin * 2;
  const svgH = height * S + margin * 2;
  
  // Find the a0 pin position (this is where comp.x, comp.y should map to)
  // For GC: a0 is at tp_length (narrow end) per IHP PDK
  let anchorX = 0, anchorY = 0;
  if (pins) {
    if (pins.a0) {
      anchorX = pins.a0.x;
      anchorY = pins.a0.y;
    } else if (pins.opt_in) {
      anchorX = pins.opt_in.x;
      anchorY = pins.opt_in.y;
    } else {
      // Use first pin
      const firstPin = Object.values(pins)[0];
      if (firstPin) {
        anchorX = firstPin.x;
        anchorY = firstPin.y;
      }
    }
  }
  
  // Calculate where the anchor point is in SVG coordinates
  const anchorSvgX = (anchorX - minX) * S + margin;
  const anchorSvgY = (maxY - anchorY) * S + margin;
  
  // Offset so anchor is at (0,0) of the div
  const marginLeft = -anchorSvgX;
  const marginTop = -anchorSvgY;
  
  return (
    <svg 
      width={svgW} 
      height={svgH} 
      style={{
        overflow: "visible", 
        display: "block",
        marginLeft: marginLeft,
        marginTop: marginTop
      }}
    >
      <LayerPatternDefs />
      <g transform={`rotate(${rotation}, ${anchorSvgX}, ${anchorSvgY})`}>
        {/* Render all visible polygons */}
        {visiblePolygons.map((poly, idx) => {
          const layerInfo = POLY_LAYER_COLORS[poly.layer] || { color: "#888888", opacity: 0.5, pattern: "solid" };
          const color = layerInfo.color;
          const isHighlighted = highlightLayer === poly.layer;
          const opacity = isHighlighted ? 1 : (highlightLayer !== null ? layerInfo.opacity * 0.3 : layerInfo.opacity);
          const pattern = layerInfo.pattern || "solid";
          
          const points = poly.points.map(([x, y]) => {
            const xSvg = (x - minX) * S + margin;
            const ySvg = (maxY - y) * S + margin;
            return `${xSvg},${ySvg}`;
          }).join(" ");
          
          // Use pattern fill for non-solid patterns
          const fillStyle = pattern === "solid" 
            ? color 
            : `url(#pattern-${pattern})`;
          
          return (
            <g key={idx} style={{ color: color }}>
              {/* Solid fill background */}
              <polygon
                points={points}
                fill={color}
                fillOpacity={opacity * 0.4}
                stroke="none"
              />
              {/* Pattern overlay */}
              {pattern !== "solid" && (
                <polygon
                  points={points}
                  fill={fillStyle}
                  fillOpacity={opacity}
                  stroke="none"
                />
              )}
              {/* Stroke */}
              <polygon
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={isHighlighted ? 1.5 : 0.8}
                strokeOpacity={isHighlighted ? 1 : 0.9}
              />
              {/* Highlight glow */}
              {isHighlighted && (
                <polygon
                  points={points}
                  fill="none"
                  stroke={color}
                  strokeWidth={3}
                  strokeOpacity={0.3}
                />
              )}
            </g>
          );
        })}
        
        {selected && (
          <rect
            x={margin - 3}
            y={margin - 3}
            width={width * S + 6}
            height={height * S + 6}
            fill="none"
            stroke={darkMode ? "#58a6ff" : "#1565c0"}
            strokeWidth={2}
            strokeDasharray="6 3"
            rx={4}
          />
        )}
      </g>
    </svg>
  );
});

// ═══ RENDERERS ═══
// Return {svg, pins} where pins=[{id,dx,dy,layer}] (µm offsets from primary pin)
// SVG uses negative margins to position content relative to pin at (0,0)

function renderGC(p,sel,S,rot=0){
  const L=p.taper_len,H=p.tp_width,w=p.wg_width;
  const Lp=L*S,Hp=Math.max(H*S,8),wp=Math.max(w*S,1.5);
  const M=4,px0=M,py0=M+Hp/2;
  const n=Math.min(Math.round(L/p.period),200);
  const pins=[{id:"wg_out",dx:0,dy:0,layer:"SiNWG"},{id:"gc_in",dx:L,dy:0,layer:"SiNWG"}];
  const svg=(
    <svg width={Lp+M*2} height={Hp+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+Hp/2)}}>
      <g transform={`rotate(${rot},${px0},${py0})`}>
        <polygon points={`${px0},${py0-wp/2} ${px0+Lp},${py0-Hp/2} ${px0+Lp},${py0+Hp/2} ${px0},${py0+wp/2}`}
          fill={LAYERS.SiN.color} opacity={0.22} stroke={LAYERS.SiN.color} strokeWidth={0.8}/>
        {Array.from({length:n},(_,i)=>{const t=i/n,x=px0+t*Lp,h=wp+(Hp-wp)*t;
          return <rect key={i} x={x} y={py0-h/2} width={Math.max(1,h*0.2)} height={h} fill={LAYERS.SiN.color} opacity={0.1+0.5*t}/>;
        })}
        <rect x={px0-3} y={py0-wp/2} width={6} height={wp} fill={LAYERS.SiN.color} opacity={0.9}/>
        {sel&&<rect x={px0-2} y={py0-Hp/2-2} width={Lp+4} height={Hp+4} fill="none" stroke="#0277bd" strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
        <text x={px0+Lp/2} y={py0+Hp/2+10} textAnchor="middle" fill={LAYERS.SiN.color} fontSize={8} fontFamily="monospace">GC Λ={p.period} L={L}µm</text>
      </g>
    </svg>);
  return{svg,pins};
}

function renderEAM(p,sel,S,rot=0){
  const tL=p.gr_length+p.wg_extra,gL=p.gr_length,gW=p.gr_width,ww=p.wg_width,go=p.gm1_offset,po=p.pass_overlap;
  const x0g=tL/2-gL/2;
  const gy_t=-ww/2+gW/2,gy_b=ww/2-gW/2;
  const my_t=gy_t+Math.abs(go)+ww,my_b=gy_b-Math.abs(go)-ww;
  const pins=[
    {id:"opt_in",dx:0,dy:0,layer:"SiNWG"},{id:"opt_out",dx:tL,dy:0,layer:"SiNWG"},
    {id:"m_top_L",dx:x0g,dy:-my_t,layer:"GM1"},{id:"m_top_R",dx:x0g+gL,dy:-my_t,layer:"GM1"},
    {id:"m_bot_L",dx:x0g,dy:-my_b,layer:"GM1"},{id:"m_bot_R",dx:x0g+gL,dy:-my_b,layer:"GM1"},
  ];
  const M=6,tE=Math.abs(my_t)+gW/2+2,bE=Math.abs(my_b)+gW/2+2;
  const svgH=(tE+bE)*S+M*2+12,svgW=tL*S+M*2;
  const px0=M,py0=M+tE*S;
  const ny=v=>py0-v*S;
  const vs=p.via_size||0.36,vg=p.via_gap||0.36,vrs=p.via_row_spacing||0.72,vR=Math.min(p.via_rows||4,10);
  const vL=p.via_length||gL,vO=p.via_start_offset||0,vP=vs+vg,nC=Math.max(1,Math.floor(vL/vP));
  const vSz=Math.max(2.5,vs*S);
  const tCY=Math.abs(go)+ww/2+vO,bCY=-(ww/2+vs+Math.abs(go)+vO);
  const vias=[];
  for(let i=0;i<nC;i++){const vx=px0+(x0g+vO+i*vP)*S;
    for(let r=0;r<vR;r++){
      vias.push(<rect key={`t${i}-${r}`} x={vx} y={ny(tCY+r*vrs)-vSz} width={vSz} height={vSz} fill={LAYERS.VIA.color} opacity={0.9}/>);
      vias.push(<rect key={`b${i}-${r}`} x={vx} y={ny(bCY-r*vrs)} width={vSz} height={vSz} fill={LAYERS.VIA.color} opacity={0.9}/>);
    }}
  const gH=Math.max(gW*S,4),gI=Math.max(gH*0.12,1);
  const svg=(
    <svg width={svgW} height={svgH} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+tE*S)}}>
      <g transform={`rotate(${rot},${px0},${py0})`}>
        <rect x={px0+(x0g-po/2)*S} y={ny(gy_t)-gW*S/2-po*S/4} width={(gL+po)*S} height={(Math.abs(gy_t-gy_b)+gW+po/2)*S}
          fill={LAYERS.GPS.color} opacity={LAYERS.GPS.op} rx={2}/>
        <rect x={px0+x0g*S} y={ny(my_t)-gH/2} width={gL*S} height={gH} fill={LAYERS.GM1.color} opacity={LAYERS.GM1.op} rx={1}/>
        <rect x={px0+x0g*S+gI} y={ny(my_t)-gH/2+gI} width={gL*S-gI*2} height={gH-gI*2} fill={LAYERS.GCT.color} opacity={0.7} rx={1}/>
        <rect x={px0+x0g*S} y={ny(gy_t)-gW*S/2} width={gL*S} height={gW*S} fill={LAYERS.GRT.color} opacity={LAYERS.GRT.op} rx={1}/>
        <rect x={px0} y={py0-ww*S/2} width={tL*S} height={Math.max(ww*S,1.5)} fill={LAYERS.SiN.color} opacity={LAYERS.SiN.op} rx={1}/>
        <rect x={px0+x0g*S} y={ny(gy_b)-gW*S/2} width={gL*S} height={gW*S} fill={LAYERS.GRB.color} opacity={LAYERS.GRB.op} rx={1}/>
        <rect x={px0+x0g*S} y={ny(my_b)-gH/2} width={gL*S} height={gH} fill={LAYERS.GM1.color} opacity={LAYERS.GM1.op} rx={1}/>
        <rect x={px0+x0g*S+gI} y={ny(my_b)-gH/2+gI} width={gL*S-gI*2} height={gH-gI*2} fill={LAYERS.GCT.color} opacity={0.7} rx={1}/>
        {vias}
        {sel&&<rect x={px0-2} y={ny(my_t)-gH/2-3} width={tL*S+4} height={ny(my_b)+gH/2+3-(ny(my_t)-gH/2-3)}
          fill="none" stroke="#2e7d32" strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
        <text x={px0+tL*S/2} y={ny(my_b)+gH/2+14} textAnchor="middle" fill={LAYERS.GRT.color} fontSize={8} fontFamily="monospace">EAM L={gL}µm W={gW}µm</text>
      </g>
    </svg>);
  return{svg,pins};
}

function renderRing(p,sel,S,rot=0){
  const r=p.radius,ww=p.wg_width,g=p.gap;
  const rP=r*S,wP=Math.max(ww*S,1.5),gP=Math.max(g*S,1.5);
  const rCY=ww/2+g+r;
  const pins=[{id:"a0",dx:0,dy:0,layer:"SiNWG"},{id:"b0",dx:2*r,dy:0,layer:"SiNWG"}];
  const grTh=(180/Math.PI)*(p.gr_length/r),hT=Math.min(grTh/2,80);
  // Graphene should be centered at 0° (right side of ring, opposite to coupling point at bottom)
  // In SVG/screen coords: 0° is at 3 o'clock (right), 90° is at 6 o'clock (bottom)
  const aS=0-hT,aE=0+hT,tr=d=>d*Math.PI/180;
  const M=8,pS=(p.pad_size||0)>0?Math.min(p.pad_size*S,rP*1.5):0;
  const svgW=2*rP+M*2+(pS>0?pS+10:0),svgH=2*rP+gP+wP+M*2+16;
  const px0=M,py0=M+2*rP+gP+wP/2;
  const cx=px0+rP,cy=py0-rCY*S;
  const ap=(R,a1,a2)=>{const x1=cx+R*Math.cos(tr(a1)),y1=cy+R*Math.sin(tr(a1)),x2=cx+R*Math.cos(tr(a2)),y2=cy+R*Math.sin(tr(a2));
    return`M ${x1} ${y1} A ${R} ${R} 0 ${Math.abs(a2-a1)>180?1:0} 1 ${x2} ${y2}`;};
  const grTR=(r-5*ww)*S,grBR=(r+5*ww)*S,ch=20;
  const gm1TR=(r-(ww*11)/2-ch/2+ww)*S,gm1BR=(r+(ww*11)/2+ch/2-ww)*S;
  const dR=Math.max((r-15)*S,4);
  const svg=(
    <svg width={svgW} height={svgH} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(py0-M)}}>
      <g transform={`rotate(${rot},${px0},${py0})`}>
        <circle cx={cx} cy={cy} r={rP} fill="none" stroke={LAYERS.SiN.color} strokeWidth={wP} opacity={LAYERS.SiN.op}/>
        <path d={ap(grBR,aS-1,aE+1)} fill="none" stroke={LAYERS.GPS.color} strokeWidth={(ww*11)*S*0.6+2} opacity={LAYERS.GPS.op}/>
        <path d={ap(grTR,aS,aE)} fill="none" stroke={LAYERS.GRT.color} strokeWidth={Math.max((ww*11)*S*0.3,2)} opacity={LAYERS.GRT.op}/>
        <path d={ap(grBR,aS,aE)} fill="none" stroke={LAYERS.GRB.color} strokeWidth={Math.max((ww*11)*S*0.3,2)} opacity={LAYERS.GRB.op}/>
        <path d={ap(gm1TR,aS,aE)} fill="none" stroke={LAYERS.GM1.color} strokeWidth={Math.max(ch*S*0.06,2)} opacity={LAYERS.GM1.op}/>
        <path d={ap(gm1BR,aS,aE)} fill="none" stroke={LAYERS.GM1.color} strokeWidth={Math.max(ch*S*0.06,2)} opacity={LAYERS.GM1.op}/>
        <circle cx={cx} cy={cy} r={dR} fill={LAYERS.GM1.color} opacity={0.12} stroke={LAYERS.GM1.color} strokeWidth={0.8}/>
        <circle cx={cx} cy={cy} r={dR*0.85} fill={LAYERS.GCT.color} opacity={0.18}/>
        {pS>0&&<><rect x={cx+rP+4} y={cy-pS/2} width={pS} height={pS} fill={LAYERS.GM1.color} opacity={0.15} stroke={LAYERS.GM1.color} strokeWidth={1} rx={2}/>
          <rect x={cx+rP+4+pS*0.1} y={cy-pS*0.4} width={pS*0.8} height={pS*0.8} fill={LAYERS.GCT.color} opacity={0.25} rx={1}/></>}
        <rect x={px0} y={py0-wP/2} width={2*rP} height={wP} fill={LAYERS.SiN.color} opacity={LAYERS.SiN.op} rx={0.5}/>
        {sel&&<rect x={px0-3} y={cy-rP-5} width={svgW-M*2+6} height={py0+wP/2+3-(cy-rP-5)}
          fill="none" stroke="#c62828" strokeWidth={1.5} strokeDasharray="5 3" rx={4}/>}
        <text x={cx} y={py0+wP/2+12} textAnchor="middle" fill="#c62828" fontSize={8} fontFamily="monospace">Ring R={r}µm gap={g}µm</text>
      </g>
    </svg>);
  return{svg,pins};
}

function renderRacetrack(p,sel,S,rot=0){
  const r=p.radius,ww=p.wg_width,g=p.gap,cl=p.coupling_length||10;
  const rP=r*S,wP=Math.max(ww*S,1.5),gP=Math.max(g*S,1.5),clP=cl*S;
  const rCY=ww/2+g+r;
  const totalW=2*r+cl;
  const pins=[{id:"a0",dx:0,dy:0,layer:"SiNWG"},{id:"b0",dx:totalW,dy:0,layer:"SiNWG"}];
  const grTh=(180/Math.PI)*(p.gr_length/r),hT=Math.min(grTh/2,80);
  // Graphene centered at 0° (right side of racetrack)
  const aS=0-hT,aE=0+hT,tr=d=>d*Math.PI/180;
  const M=8,pS=(p.pad_size||0)>0?Math.min(p.pad_size*S,rP*1.5):0;
  const svgW=totalW*S+M*2+(pS>0?pS+10:0),svgH=2*rP+gP+wP+M*2+16;
  const px0=M,py0=M+2*rP+gP+wP/2;
  const cxL=px0+rP,cxR=px0+rP+clP,cy=py0-rCY*S;
  // Arc path helper for right semicircle
  const apR=(R,a1,a2)=>{const x1=cxR+R*Math.cos(tr(a1)),y1=cy+R*Math.sin(tr(a1)),x2=cxR+R*Math.cos(tr(a2)),y2=cy+R*Math.sin(tr(a2));
    return`M ${x1} ${y1} A ${R} ${R} 0 ${Math.abs(a2-a1)>180?1:0} 1 ${x2} ${y2}`;};
  const grTR=(r-5*ww)*S,grBR=(r+5*ww)*S,ch=20;
  const gm1TR=(r-(ww*11)/2-ch/2+ww)*S,gm1BR=(r+(ww*11)/2+ch/2-ww)*S;
  const dR=Math.max((r-15)*S,4);
  const svg=(
    <svg width={svgW} height={svgH} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(py0-M)}}>
      <g transform={`rotate(${rot},${px0},${py0})`}>
        {/* Racetrack shape: two semicircles connected by straight sections */}
        <path d={`M ${cxL} ${cy-rP} L ${cxR} ${cy-rP} A ${rP} ${rP} 0 0 1 ${cxR} ${cy+rP} L ${cxL} ${cy+rP} A ${rP} ${rP} 0 0 1 ${cxL} ${cy-rP}`}
          fill="none" stroke={LAYERS.SiN.color} strokeWidth={wP} opacity={LAYERS.SiN.op}/>
        {/* Graphene layers on right semicircle */}
        <path d={apR(grBR,aS-1,aE+1)} fill="none" stroke={LAYERS.GPS.color} strokeWidth={(ww*11)*S*0.6+2} opacity={LAYERS.GPS.op}/>
        <path d={apR(grTR,aS,aE)} fill="none" stroke={LAYERS.GRT.color} strokeWidth={Math.max((ww*11)*S*0.3,2)} opacity={LAYERS.GRT.op}/>
        <path d={apR(grBR,aS,aE)} fill="none" stroke={LAYERS.GRB.color} strokeWidth={Math.max((ww*11)*S*0.3,2)} opacity={LAYERS.GRB.op}/>
        <path d={apR(gm1TR,aS,aE)} fill="none" stroke={LAYERS.GM1.color} strokeWidth={Math.max(ch*S*0.06,2)} opacity={LAYERS.GM1.op}/>
        <path d={apR(gm1BR,aS,aE)} fill="none" stroke={LAYERS.GM1.color} strokeWidth={Math.max(ch*S*0.06,2)} opacity={LAYERS.GM1.op}/>
        {/* Center contact */}
        <ellipse cx={(cxL+cxR)/2} cy={cy} rx={dR+clP/2} ry={dR} fill={LAYERS.GM1.color} opacity={0.12} stroke={LAYERS.GM1.color} strokeWidth={0.8}/>
        <ellipse cx={(cxL+cxR)/2} cy={cy} rx={(dR+clP/2)*0.85} ry={dR*0.85} fill={LAYERS.GCT.color} opacity={0.18}/>
        {/* Pad */}
        {pS>0&&<><rect x={cxR+rP+4} y={cy-pS/2} width={pS} height={pS} fill={LAYERS.GM1.color} opacity={0.15} stroke={LAYERS.GM1.color} strokeWidth={1} rx={2}/>
          <rect x={cxR+rP+4+pS*0.1} y={cy-pS*0.4} width={pS*0.8} height={pS*0.8} fill={LAYERS.GCT.color} opacity={0.25} rx={1}/></>}
        {/* Bus waveguide */}
        <rect x={px0} y={py0-wP/2} width={totalW*S} height={wP} fill={LAYERS.SiN.color} opacity={LAYERS.SiN.op} rx={0.5}/>
        {sel&&<rect x={px0-3} y={cy-rP-5} width={svgW-M*2+6} height={py0+wP/2+3-(cy-rP-5)}
          fill="none" stroke="#c62828" strokeWidth={1.5} strokeDasharray="5 3" rx={4}/>}
        <text x={(cxL+cxR)/2} y={py0+wP/2+12} textAnchor="middle" fill="#c62828" fontSize={8} fontFamily="monospace">RT R={r}µm L={cl}µm</text>
      </g>
    </svg>);
  return{svg,pins};
}

function renderPad(p,sel,S,rot=0){
  const W=p.pad_length,H=p.pad_width,of=p.open_factor||0.4;
  const Wp=W*S,Hp=H*S,iW=Wp*(1-of),iH=Hp*(1-of);
  // 4 pins at middle of each edge. Primary = pad_l at left edge center (0,0)
  const pins=[
    {id:"pad_l", dx:0,   dy:0,    layer:"GM1"},
    {id:"pad_r", dx:W,   dy:0,    layer:"GM1"},
    {id:"pad_t", dx:W/2, dy:-H/2, layer:"GM1"},
    {id:"pad_b", dx:W/2, dy:H/2,  layer:"GM1"},
    {id:"pad_a", dx:W/2, dy:H/2,  layer:"GM1"}, // backward compat
  ];
  const M=4;
  const px0=M, py0=M+Hp/2;
  const svg=(
    <svg width={Wp+M*2} height={Hp+M*2+12} style={{overflow:"visible",display:"block",
      marginLeft:-M,marginTop:-(M+Hp/2)}}>
      <g transform={`rotate(${rot},${px0},${py0})`}>
        <rect x={px0} y={py0-Hp/2} width={Wp} height={Hp}
          fill={LAYERS.GM1.color} opacity={0.15} stroke={LAYERS.GM1.color} strokeWidth={1.5} rx={2}/>
        <rect x={px0+(Wp-iW)/2} y={py0-iH/2} width={iW} height={iH}
          fill={LAYERS.GCT.color} opacity={0.35} stroke={LAYERS.GCT.color} strokeWidth={0.5} rx={1}/>
        <line x1={px0+Wp/2} y1={py0-Hp/2+3} x2={px0+Wp/2} y2={py0+Hp/2-3}
          stroke={LAYERS.GM1.color} strokeWidth={0.4} opacity={0.2}/>
        <line x1={px0+3} y1={py0} x2={px0+Wp-3} y2={py0}
          stroke={LAYERS.GM1.color} strokeWidth={0.4} opacity={0.2}/>
        {sel&&<rect x={px0-3} y={py0-Hp/2-3} width={Wp+6} height={Hp+6}
          fill="none" stroke="#00695c" strokeWidth={1.5} strokeDasharray="5 3" rx={4}/>}
        <text x={px0+Wp/2} y={py0+Hp/2+10} textAnchor="middle"
          fill={LAYERS.GM1.color} fontSize={8} fontFamily="monospace">PAD {W}×{H}µm</text>
      </g>
    </svg>);
  return{svg,pins};
}

// ═══ NAZCA GEOMETRY SHAPE RENDERERS ═══
// Each shape has a "layer" param: "SiN" or "GM1" for layer selection
// Pin at left edge center (0,0) for shapes with width, center for circles
function shapeColor(layer){ 
  const PDK_C={"GraphBot":"#c62828","GraphTop":"#2e7d32","GraphGate":"#6a1b9a","GraphCont":"#795548",
    "GraphMetal1":"#d84315","GraphMet1L":"#e65100","SiWG":"#0277bd","SiNWG":"#1565c0",
    "SiGrating":"#00838f","SiNGrating":"#00695c","GraphPas":"#f9a825","GraphPAD":"#4e342e","Alignment":"#546e7a",
    "SiN":"#1565c0","GM1":"#d84315"};
  return PDK_C[layer]||"#1565c0";
}
function shapeLayerNum(layer){
  const PDK_N={"GraphBot":78,"GraphTop":79,"GraphGate":118,"GraphCont":85,
    "GraphMetal1":109,"GraphMet1L":110,"SiWG":86,"SiNWG":119,
    "SiGrating":87,"SiNGrating":88,"GraphPas":89,"GraphPAD":97,"Alignment":234,
    "SiN":119,"GM1":109};
  return PDK_N[layer]||119;
}

function renderRectangle(p,sel,S,rot=0){
  const W=p.length,H=p.height,c=shapeColor(p.layer),op=0.28;
  const Wp=W*S,Hp=H*S,M=4,px0=M,py0=M+Hp/2;
  const pins=[{id:"left",dx:0,dy:0,layer:p.layer||"SiN"},{id:"right",dx:W,dy:0,layer:p.layer||"SiN"},
    {id:"top",dx:W/2,dy:-H/2,layer:p.layer||"SiN"},{id:"bottom",dx:W/2,dy:H/2,layer:p.layer||"SiN"}];
  const svg=(<svg width={Wp+M*2} height={Hp+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+Hp/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <rect x={px0} y={py0-Hp/2} width={Wp} height={Hp} fill={c} opacity={op} stroke={c} strokeWidth={1} rx={1}/>
      {sel&&<rect x={px0-2} y={py0-Hp/2-2} width={Wp+4} height={Hp+4} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Wp/2} y={py0+Hp/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Rect {W}×{H}</text>
    </g></svg>);
  return{svg,pins};
}

function renderCircle(p,sel,S,rot=0){
  const r=p.radius,c=shapeColor(p.layer),op=0.28;
  const rP=r*S,M=4,cx=M+rP,cy=M+rP;
  // Pin at center (0,0)=center, plus L/R/T/B at edges
  const pins=[{id:"center",dx:0,dy:0,layer:p.layer||"SiN"},
    {id:"left",dx:-r,dy:0,layer:p.layer||"SiN"},{id:"right",dx:r,dy:0,layer:p.layer||"SiN"},
    {id:"top",dx:0,dy:-r,layer:p.layer||"SiN"},{id:"bottom",dx:0,dy:r,layer:p.layer||"SiN"}];
  const svg=(<svg width={rP*2+M*2} height={rP*2+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-(M+rP),marginTop:-(M+rP)}}>
    <g transform={`rotate(${rot},${cx},${cy})`}>
      <circle cx={cx} cy={cy} r={rP} fill={c} opacity={op} stroke={c} strokeWidth={1}/>
      {sel&&<circle cx={cx} cy={cy} r={rP+3} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3"/>}
      <text x={cx} y={cy+rP+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Circle r={r}</text>
    </g></svg>);
  return{svg,pins};
}

function renderGeoRing(p,sel,S,rot=0){
  const r=p.radius,w=p.width,c=shapeColor(p.layer),op=0.28;
  const rP=r*S,wP=Math.max(w*S,1.5),M=4,cx=M+rP,cy=M+rP;
  const pins=[{id:"center",dx:0,dy:0,layer:p.layer||"SiN"},
    {id:"left",dx:-r,dy:0,layer:p.layer||"SiN"},{id:"right",dx:r,dy:0,layer:p.layer||"SiN"}];
  const svg=(<svg width={rP*2+M*2} height={rP*2+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-(M+rP),marginTop:-(M+rP)}}>
    <g transform={`rotate(${rot},${cx},${cy})`}>
      <circle cx={cx} cy={cy} r={rP} fill="none" stroke={c} strokeWidth={wP} opacity={op}/>
      {sel&&<circle cx={cx} cy={cy} r={rP+wP/2+3} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3"/>}
      <text x={cx} y={cy+rP+wP/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Ring r={r} w={w}</text>
    </g></svg>);
  return{svg,pins};
}

function renderArc(p,sel,S,rot=0){
  const r=p.radius,w=p.width,ang=p.angle,c=shapeColor(p.layer),op=0.28;
  const rP=r*S,wP=Math.max(w*S,1.5),M=4;
  const rad=d=>d*Math.PI/180;
  
  // Arc points - standard math coords
  const x1 = rP * Math.cos(rad(0));
  const y1 = rP * Math.sin(rad(0));
  const x2 = rP * Math.cos(rad(ang));
  const y2 = rP * Math.sin(rad(ang));
  
  const lg = Math.abs(ang) > 180 ? 1 : 0;
  const sw = ang > 0 ? 0 : 1;
  const cx = M + rP, cy = M + rP;
  const d = `M${cx+x1},${cy-y1} A${rP},${rP} 0 ${lg} ${sw} ${cx+x2},${cy-y2}`;
  
  // Pins in component coords (match GDS)
  const pins = [
    {id: "a0", dx: r, dy: 0, layer: p.layer || "SiN"},
    {id: "b0", dx: r * Math.cos(rad(ang)), dy: -r * Math.sin(rad(ang)), layer: p.layer || "SiN"},
    {id: "center", dx: 0, dy: 0, layer: p.layer || "SiN"}
  ];
  
  // Add 90° to rotation to match GDS preview visually
  const visualRot = rot + -90;
  
  const svg = (
    <svg width={rP*2+M*2} height={rP*2+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-(M+rP),marginTop:-(M+rP)}}>
      <g transform={`rotate(${visualRot},${cx},${cy})`}>
        <circle cx={cx} cy={cy} r={2} fill={c} opacity={0.3}/>
        <path d={d} fill="none" stroke={c} strokeWidth={wP} opacity={op} strokeLinecap="round"/>
        <circle cx={cx+x1} cy={cy-y1} r={3} fill={c} stroke="#fff" strokeWidth={1}/>
        <circle cx={cx+x2} cy={cy-y2} r={3} fill={c} stroke="#fff" strokeWidth={1}/>
        {sel && <circle cx={cx} cy={cy} r={rP+wP/2+3} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3"/>}
        <text x={cx} y={cy+rP+wP/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace" transform={`rotate(${-visualRot},${cx},${cy+rP+wP/2+10})`}>Arc r={r} θ={ang}°</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

function renderTaper(p,sel,S,rot=0){
  const L=p.length,w1=p.width1,w2=p.width2,c=shapeColor(p.layer),op=0.28;
  const Lp=L*S,w1p=Math.max(w1*S,2),w2p=Math.max(w2*S,2),M=4;
  const maxH=Math.max(w1p,w2p);
  const px0=M,py0=M+maxH/2;
  const pts=`${px0},${py0-w1p/2} ${px0+Lp},${py0-w2p/2} ${px0+Lp},${py0+w2p/2} ${px0},${py0+w1p/2}`;
  const pins=[{id:"a0",dx:0,dy:0,layer:p.layer||"SiN"},{id:"b0",dx:L,dy:0,layer:p.layer||"SiN"}];
  const svg=(<svg width={Lp+M*2} height={maxH+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+maxH/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <polygon points={pts} fill={c} opacity={op} stroke={c} strokeWidth={1}/>
      {sel&&<rect x={px0-2} y={py0-maxH/2-2} width={Lp+4} height={maxH+4} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Lp/2} y={py0+maxH/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Taper {w1}→{w2}</text>
    </g></svg>);
  return{svg,pins};
}

function renderTrapezoid(p,sel,S,rot=0){
  const L=p.length,H=p.height,a1=p.angle1,a2=p.angle2,c=shapeColor(p.layer),op=0.28;
  const Lp=L*S,Hp=H*S,M=4;
  const dx1=H/Math.tan(a1*Math.PI/180)*S;
  const dx2=H/Math.tan(a2*Math.PI/180)*S;
  const px0=M,py0=M+Hp/2;
  const pts=`${px0},${py0+Hp/2} ${px0+dx1},${py0-Hp/2} ${px0+Lp-dx2},${py0-Hp/2} ${px0+Lp},${py0+Hp/2}`;
  const pins=[{id:"left",dx:0,dy:0,layer:p.layer||"SiN"},{id:"right",dx:L,dy:0,layer:p.layer||"SiN"}];
  const svg=(<svg width={Lp+M*2} height={Hp+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+Hp/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <polygon points={pts} fill={c} opacity={op} stroke={c} strokeWidth={1}/>
      {sel&&<rect x={px0-2} y={py0-Hp/2-2} width={Lp+4} height={Hp+4} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Lp/2} y={py0+Hp/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Trap {L}×{H}</text>
    </g></svg>);
  return{svg,pins};
}

function renderParallelogram(p,sel,S,rot=0){
  const L=p.length,H=p.height,a=p.angle,c=shapeColor(p.layer),op=0.28;
  const Lp=L*S,Hp=H*S,M=4;
  const dx=H/Math.tan(a*Math.PI/180)*S;
  const px0=M+Math.max(0,-dx),py0=M+Hp/2;
  const totalW=Lp+Math.abs(dx);
  const pts=`${px0},${py0+Hp/2} ${px0+dx},${py0-Hp/2} ${px0+dx+Lp},${py0-Hp/2} ${px0+Lp},${py0+Hp/2}`;
  const pins=[{id:"left",dx:0,dy:0,layer:p.layer||"SiN"},{id:"right",dx:L,dy:0,layer:p.layer||"SiN"}];
  const svg=(<svg width={totalW+M*2+Math.abs(dx)} height={Hp+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-(M+Math.max(0,-dx)),marginTop:-(M+Hp/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <polygon points={pts} fill={c} opacity={op} stroke={c} strokeWidth={1}/>
      {sel&&<rect x={M-2} y={py0-Hp/2-2} width={totalW+4} height={Hp+4} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Lp/2} y={py0+Hp/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Pgram {L}×{H} {a}°</text>
    </g></svg>);
  return{svg,pins};
}

function renderRhombus(p,sel,S,rot=0){
  const L=p.length,a=p.angle,c=shapeColor(p.layer),op=0.28;
  const H=L*Math.sin(a*Math.PI/180);
  const Lp=L*S,Hp=H*S,M=4;
  const dx=L*Math.cos(a*Math.PI/180)*S;
  const px0=M,py0=M+Hp/2;
  const pts=`${px0+Lp/2},${py0-Hp/2} ${px0+Lp},${py0} ${px0+Lp/2},${py0+Hp/2} ${px0},${py0}`;
  const pins=[{id:"left",dx:0,dy:0,layer:p.layer||"SiN"},{id:"right",dx:L,dy:0,layer:p.layer||"SiN"}];
  const svg=(<svg width={Lp+M*2} height={Hp+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+Hp/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <polygon points={pts} fill={c} opacity={op} stroke={c} strokeWidth={1}/>
      {sel&&<rect x={px0-2} y={py0-Hp/2-2} width={Lp+4} height={Hp+4} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Lp/2} y={py0+Hp/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Rhombus L={L}</text>
    </g></svg>);
  return{svg,pins};
}

function renderRoundedRect(p,sel,S,rot=0){
  const W=p.length,H=p.height,sh=p.shrink,c=shapeColor(p.layer),op=0.28;
  const Wp=W*S,Hp=H*S,rr=Math.min(sh*Math.min(W,H)*S,Wp/2,Hp/2),M=4,px0=M,py0=M+Hp/2;
  const pins=[{id:"left",dx:0,dy:0,layer:p.layer||"SiN"},{id:"right",dx:W,dy:0,layer:p.layer||"SiN"},
    {id:"top",dx:W/2,dy:-H/2,layer:p.layer||"SiN"},{id:"bottom",dx:W/2,dy:H/2,layer:p.layer||"SiN"}];
  const svg=(<svg width={Wp+M*2} height={Hp+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+Hp/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <rect x={px0} y={py0-Hp/2} width={Wp} height={Hp} rx={rr} ry={rr} fill={c} opacity={op} stroke={c} strokeWidth={1}/>
      {sel&&<rect x={px0-2} y={py0-Hp/2-2} width={Wp+4} height={Hp+4} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3" rx={rr+2}/>}
      <text x={px0+Wp/2} y={py0+Hp/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">RndRect {W}×{H}</text>
    </g></svg>);
  return{svg,pins};
}

function renderFrame(p,sel,S,rot=0){
  const fw=p.frame_width,fl=p.frame_length,fh=p.frame_height,c=shapeColor(p.layer),op=0.28;
  const Lp=fl*S,Hp=fh*S,wp=fw*S,M=4,px0=M,py0=M+Hp/2;
  const pins=[{id:"left",dx:0,dy:0,layer:p.layer||"SiN"},{id:"right",dx:fl,dy:0,layer:p.layer||"SiN"}];
  const svg=(<svg width={Lp+M*2} height={Hp+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+Hp/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <rect x={px0} y={py0-Hp/2} width={Lp} height={Hp} fill={c} opacity={op} stroke={c} strokeWidth={1} rx={1}/>
      <rect x={px0+wp} y={py0-Hp/2+wp} width={Lp-2*wp} height={Hp-2*wp} fill="#f5f5f5" stroke={c} strokeWidth={0.5} rx={1}/>
      {sel&&<rect x={px0-2} y={py0-Hp/2-2} width={Lp+4} height={Hp+4} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Lp/2} y={py0+Hp/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Frame {fl}×{fh} w={fw}</text>
    </g></svg>);
  return{svg,pins};
}

function renderPie(p,sel,S,rot=0){
  const r=p.radius,ang=p.angle,c=shapeColor(p.layer),op=0.28;
  const rP=r*S,M=4,cx=M+rP,cy=M+rP;
  const rad=d=>d*Math.PI/180;
  const x1=rP,y1=0;
  const x2=rP*Math.cos(rad(ang)),y2=-rP*Math.sin(rad(ang));
  const lg=Math.abs(ang)>180?1:0;
  const d=`M${cx},${cy} L${cx+x1},${cy+y1} A${rP},${rP} 0 ${lg} 0 ${cx+x2},${cy+y2} Z`;
  const pins=[{id:"center",dx:0,dy:0,layer:p.layer||"SiN"},{id:"edge",dx:r,dy:0,layer:p.layer||"SiN"}];
  const svg=(<svg width={rP*2+M*2} height={rP*2+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-(M+rP),marginTop:-(M+rP)}}>
    <g transform={`rotate(${rot},${cx},${cy})`}>
      <path d={d} fill={c} opacity={op} stroke={c} strokeWidth={1}/>
      {sel&&<circle cx={cx} cy={cy} r={rP+3} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3"/>}
      <text x={cx} y={cy+rP+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Pie r={r} θ={ang}°</text>
    </g></svg>);
  return{svg,pins};
}

function renderTetragon(p,sel,S,rot=0){
  const L=p.length,H=p.height,dx=p.dx,x=p.x_top,c=shapeColor(p.layer),op=0.28;
  const Lp=L*S,Hp=H*S,dxP=dx*S,xP=x*S,M=4;
  const maxX=Math.max(Lp,xP+dxP);
  const px0=M,py0=M+Hp/2;
  const pts=`${px0},${py0+Hp/2} ${px0+Lp},${py0+Hp/2} ${px0+xP+dxP},${py0-Hp/2} ${px0+xP},${py0-Hp/2}`;
  const pins=[{id:"left",dx:0,dy:0,layer:p.layer||"SiN"},{id:"right",dx:Math.max(L,x+dx),dy:0,layer:p.layer||"SiN"}];
  const svg=(<svg width={maxX+M*2} height={Hp+M*2+12} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+Hp/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <polygon points={pts} fill={c} opacity={op} stroke={c} strokeWidth={1}/>
      {sel&&<rect x={px0-2} y={py0-Hp/2-2} width={maxX+4} height={Hp+4} fill="none" stroke={c} strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+maxX/2} y={py0+Hp/2+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="monospace">Tetragon</text>
    </g></svg>);
  return{svg,pins};
}

// ═══ PHOTONIC BUILDING BLOCK RENDERERS ═══

function renderMMI(p,sel,S,rot=0){
  const L=p.mmi_length,W=p.mmi_width,wg=p.wg_width,ni=p.num_inputs||1,no=p.num_outputs||2;
  const Lp=L*S,Wp=W*S,wp=Math.max(wg*S,1.5),M=6;
  const taperL=Math.min(L*0.15,10)*S;
  const px0=M+taperL,py0=M+Wp/2;
  // Input pins on left, output pins on right
  const pins=[];
  for(let i=0;i<ni;i++){const oy=ni===1?0:(i-(ni-1)/2)*(W/(ni+1));pins.push({id:`a${i}`,dx:-taperL/S,dy:oy,layer:"SiN"})}
  for(let i=0;i<no;i++){const oy=no===1?0:(i-(no-1)/2)*(W/(no+1));pins.push({id:`b${i}`,dx:L+taperL/S,dy:oy,layer:"SiN"})}
  const svg=(<svg width={Lp+taperL*2+M*2} height={Wp+M*2+14} style={{overflow:"visible",display:"block",marginLeft:-(M+taperL),marginTop:-(M+Wp/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      {/* MMI body */}
      <rect x={px0} y={py0-Wp/2} width={Lp} height={Wp} fill="#1565c0" opacity={0.18} stroke="#1565c0" strokeWidth={1.2} rx={2}/>
      {/* Input tapers */}
      {Array.from({length:ni},(_,i)=>{const oy=(ni===1?0:(i-(ni-1)/2)*(W/(ni+1)))*S;
        return <polygon key={`i${i}`} points={`${px0-taperL},${py0+oy-wp/2} ${px0},${py0+oy-wp*1.5} ${px0},${py0+oy+wp*1.5} ${px0-taperL},${py0+oy+wp/2}`}
          fill="#1565c0" opacity={0.25} stroke="#1565c0" strokeWidth={0.6}/>})}
      {/* Output tapers */}
      {Array.from({length:no},(_,i)=>{const oy=(no===1?0:(i-(no-1)/2)*(W/(no+1)))*S;
        return <polygon key={`o${i}`} points={`${px0+Lp},${py0+oy-wp*1.5} ${px0+Lp+taperL},${py0+oy-wp/2} ${px0+Lp+taperL},${py0+oy+wp/2} ${px0+Lp},${py0+oy+wp*1.5}`}
          fill="#1565c0" opacity={0.25} stroke="#1565c0" strokeWidth={0.6}/>})}
      {/* Input WG stubs */}
      {Array.from({length:ni},(_,i)=>{const oy=(ni===1?0:(i-(ni-1)/2)*(W/(ni+1)))*S;
        return <rect key={`wi${i}`} x={px0-taperL-4} y={py0+oy-wp/2} width={6} height={wp} fill="#1565c0" opacity={0.8}/>})}
      {/* Output WG stubs */}
      {Array.from({length:no},(_,i)=>{const oy=(no===1?0:(i-(no-1)/2)*(W/(no+1)))*S;
        return <rect key={`wo${i}`} x={px0+Lp+taperL-2} y={py0+oy-wp/2} width={6} height={wp} fill="#1565c0" opacity={0.8}/>})}
      {sel&&<rect x={px0-taperL-3} y={py0-Wp/2-3} width={Lp+taperL*2+6} height={Wp+6} fill="none" stroke="#0277bd" strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Lp/2} y={py0+Wp/2+11} textAnchor="middle" fill="#1565c0" fontSize={9} fontFamily="monospace" fontWeight={600}>MMI {ni}×{no}</text>
    </g></svg>);
  return{svg,pins};
}

function renderDC(p,sel,S,rot=0){
  const L=p.coupling_length,gap=p.gap,wg=p.wg_width,Lstr=p.straight_length||20;
  const Lp=L*S,gp=Math.max(gap*S,2),wp=Math.max(wg*S,1.5),Ls=Lstr*S,M=6;
  const totalW=Lp+Ls*2;
  const px0=M,py0=M+gp/2+wp;
  // Two waveguides: top (through) and bottom (cross), with S-bends at ends
  const bendH=(gap+wg*2)*S*0.8;
  const pins=[
    {id:"a0",dx:0,dy:0,layer:"SiN"},           // top-left in
    {id:"b0",dx:L+Lstr*2,dy:0,layer:"SiN"},    // top-right out (through)
    {id:"a1",dx:0,dy:gap+wg,layer:"SiN"},       // bottom-left in
    {id:"b1",dx:L+Lstr*2,dy:gap+wg,layer:"SiN"},// bottom-right out (cross)
  ];
  const svg=(<svg width={totalW*S+M*2} height={(gap+wg*3)*S+M*2+14} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+gp/2+wp)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      {/* Top waveguide */}
      <rect x={px0} y={py0-wp/2} width={totalW*S} height={wp} fill="#1565c0" opacity={0.7} rx={0.5}/>
      {/* Bottom waveguide */}
      <rect x={px0} y={py0+gp+wp/2} width={totalW*S} height={wp} fill="#1565c0" opacity={0.7} rx={0.5}/>
      {/* Coupling region highlight */}
      <rect x={px0+Ls*S} y={py0-wp} width={Lp} height={gp+wp*3} fill="#1565c0" opacity={0.06} stroke="#1565c0" strokeWidth={0.5} strokeDasharray="3 2" rx={3}/>
      {/* Gap indicator */}
      <line x1={px0+Ls*S+Lp/2} y1={py0+wp/2} x2={px0+Ls*S+Lp/2} y2={py0+gp+wp/2} stroke="#999" strokeWidth={0.5} strokeDasharray="2 2"/>
      {sel&&<rect x={px0-3} y={py0-wp-3} width={totalW*S+6} height={gp+wp*3+6} fill="none" stroke="#0277bd" strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+totalW*S/2} y={py0+gp+wp*2+10} textAnchor="middle" fill="#1565c0" fontSize={9} fontFamily="monospace" fontWeight={600}>DC L={L} gap={gap}</text>
    </g></svg>);
  return{svg,pins};
}

function renderPhaseMod(p,sel,S,rot=0){
  const L=p.mod_length,wg=p.wg_width,elW=p.electrode_width||10;
  const Lp=L*S,wp=Math.max(wg*S,1.5),eW=elW*S,M=6;
  const px0=M,py0=M+eW/2;
  const pins=[
    {id:"opt_in",dx:0,dy:0,layer:"SiN"},
    {id:"opt_out",dx:L,dy:0,layer:"SiN"},
    {id:"el_top",dx:L/2,dy:-(elW/2+2),layer:"GM1"},
    {id:"el_bot",dx:L/2,dy:elW/2+2,layer:"GM1"},
  ];
  const svg=(<svg width={Lp+M*2} height={eW+M*2+14} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+eW/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      {/* Electrode top */}
      <rect x={px0+Lp*0.05} y={py0-eW/2} width={Lp*0.9} height={eW/2-wp} fill="#d84315" opacity={0.2} stroke="#d84315" strokeWidth={0.8} rx={1}/>
      {/* Waveguide */}
      <rect x={px0} y={py0-wp/2} width={Lp} height={wp} fill="#1565c0" opacity={0.8} rx={0.5}/>
      {/* Electrode bottom */}
      <rect x={px0+Lp*0.05} y={py0+wp} width={Lp*0.9} height={eW/2-wp} fill="#d84315" opacity={0.2} stroke="#d84315" strokeWidth={0.8} rx={1}/>
      {/* Phase symbol */}
      <text x={px0+Lp/2} y={py0-eW/2+12} textAnchor="middle" fill="#d84315" fontSize={10} fontFamily="serif" fontStyle="italic" opacity={0.6}>φ</text>
      {sel&&<rect x={px0-3} y={py0-eW/2-3} width={Lp+6} height={eW+6} fill="none" stroke="#d84315" strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Lp/2} y={py0+eW/2+11} textAnchor="middle" fill="#d84315" fontSize={9} fontFamily="monospace" fontWeight={600}>PM L={L}µm</text>
    </g></svg>);
  return{svg,pins};
}

function renderSSC(p,sel,S,rot=0){
  const L=p.taper_length,w1=p.width_in,w2=p.width_out;
  const Lp=L*S,w1p=Math.max(w1*S,1.5),w2p=Math.max(w2*S,2),M=6;
  const maxH=Math.max(w1p,w2p);
  const px0=M,py0=M+maxH/2;
  const pins=[{id:"a0",dx:0,dy:0,layer:"SiN"},{id:"b0",dx:L,dy:0,layer:"SiN"}];
  // Draw as smooth taper (quadratic curve for edges)
  const topEdge=`M${px0},${py0-w1p/2} Q${px0+Lp/2},${py0-w2p/2-2} ${px0+Lp},${py0-w2p/2}`;
  const botEdge=`L${px0+Lp},${py0+w2p/2} Q${px0+Lp/2},${py0+w2p/2+2} ${px0},${py0+w1p/2} Z`;
  const svg=(<svg width={Lp+M*2} height={maxH+M*2+14} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+maxH/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <path d={topEdge+botEdge} fill="#1565c0" opacity={0.2} stroke="#1565c0" strokeWidth={1}/>
      {/* Center WG line */}
      <line x1={px0} y1={py0} x2={px0+Lp} y2={py0} stroke="#1565c0" strokeWidth={0.5} strokeDasharray="3 2" opacity={0.4}/>
      {/* WG stubs */}
      <rect x={px0-4} y={py0-w1p/2} width={6} height={w1p} fill="#1565c0" opacity={0.8}/>
      <rect x={px0+Lp-2} y={py0-w2p/2} width={6} height={w2p} fill="#1565c0" opacity={0.8}/>
      {sel&&<rect x={px0-3} y={py0-maxH/2-3} width={Lp+6} height={maxH+6} fill="none" stroke="#0277bd" strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Lp/2} y={py0+maxH/2+11} textAnchor="middle" fill="#1565c0" fontSize={9} fontFamily="monospace" fontWeight={600}>SSC {w1}→{w2}µm</text>
    </g></svg>);
  return{svg,pins};
}

function renderYjunction(p,sel,S,rot=0){
  const L=p.junction_length,wg=p.wg_width,sep=p.arm_separation;
  const Lp=L*S,wp=Math.max(wg*S,1.5),sepP=sep*S/2,M=6;
  const px0=M,py0=M+sepP+wp;
  const pins=[
    {id:"a0",dx:0,dy:0,layer:"SiN"},
    {id:"b0",dx:L,dy:-sep/2,layer:"SiN"},
    {id:"b1",dx:L,dy:sep/2,layer:"SiN"},
  ];
  const svg=(<svg width={Lp+M*2} height={sep*S+wp*2+M*2+14} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+sepP+wp)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      {/* Input waveguide stub */}
      <rect x={px0-4} y={py0-wp/2} width={8} height={wp} fill="#1565c0" opacity={0.8}/>
      {/* Top branch - S-curve */}
      <path d={`M${px0},${py0} C${px0+Lp*0.4},${py0} ${px0+Lp*0.6},${py0-sepP} ${px0+Lp},${py0-sepP}`}
        fill="none" stroke="#1565c0" strokeWidth={wp} opacity={0.6} strokeLinecap="round"/>
      {/* Bottom branch - S-curve */}
      <path d={`M${px0},${py0} C${px0+Lp*0.4},${py0} ${px0+Lp*0.6},${py0+sepP} ${px0+Lp},${py0+sepP}`}
        fill="none" stroke="#1565c0" strokeWidth={wp} opacity={0.6} strokeLinecap="round"/>
      {/* Junction point */}
      <circle cx={px0+2} cy={py0} r={2} fill="#1565c0" opacity={0.7}/>
      {sel&&<rect x={px0-5} y={py0-sepP-wp-3} width={Lp+10} height={sep*S+wp*2+6} fill="none" stroke="#0277bd" strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+Lp/2} y={py0+sepP+wp+11} textAnchor="middle" fill="#1565c0" fontSize={9} fontFamily="monospace" fontWeight={600}>Y-junc</text>
    </g></svg>);
  return{svg,pins};
}

function renderMZI(p,sel,S,rot=0){
  const L=p.arm_length,dL=p.delta_length||0,sep=p.arm_separation,wg=p.wg_width,splitL=p.splitter_length||20;
  const wp=Math.max(wg*S,1.5),sepP=sep*S/2,sLp=splitL*S,Lp=L*S,M=6;
  const totalL=sLp*2+Lp;
  const px0=M,py0=M+sepP+wp;
  const pins=[
    {id:"a0",dx:0,dy:0,layer:"SiN"},
    {id:"b0",dx:(splitL*2+L),dy:0,layer:"SiN"},
  ];
  const svg=(<svg width={totalL+M*2} height={sep*S+wp*2+M*2+14} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+sepP+wp)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      {/* Input splitter (Y-junction shape) */}
      <path d={`M${px0},${py0} C${px0+sLp*0.5},${py0} ${px0+sLp*0.7},${py0-sepP} ${px0+sLp},${py0-sepP}`}
        fill="none" stroke="#1565c0" strokeWidth={wp} opacity={0.6}/>
      <path d={`M${px0},${py0} C${px0+sLp*0.5},${py0} ${px0+sLp*0.7},${py0+sepP} ${px0+sLp},${py0+sepP}`}
        fill="none" stroke="#1565c0" strokeWidth={wp} opacity={0.6}/>
      {/* Top arm */}
      <rect x={px0+sLp} y={py0-sepP-wp/2} width={Lp} height={wp} fill="#1565c0" opacity={0.6} rx={0.5}/>
      {/* Bottom arm (potentially longer by dL) */}
      <rect x={px0+sLp} y={py0+sepP-wp/2} width={Lp} height={wp} fill="#1565c0" opacity={0.6} rx={0.5}/>
      {/* Output combiner */}
      <path d={`M${px0+sLp+Lp},${py0-sepP} C${px0+sLp+Lp+sLp*0.3},${py0-sepP} ${px0+sLp+Lp+sLp*0.5},${py0} ${px0+totalL},${py0}`}
        fill="none" stroke="#1565c0" strokeWidth={wp} opacity={0.6}/>
      <path d={`M${px0+sLp+Lp},${py0+sepP} C${px0+sLp+Lp+sLp*0.3},${py0+sepP} ${px0+sLp+Lp+sLp*0.5},${py0} ${px0+totalL},${py0}`}
        fill="none" stroke="#1565c0" strokeWidth={wp} opacity={0.6}/>
      {/* ΔL label if nonzero */}
      {dL>0&&<text x={px0+sLp+Lp/2} y={py0+sepP+wp+4} textAnchor="middle" fill="#1565c0" fontSize={7} fontFamily="monospace" opacity={0.5}>ΔL={dL}µm</text>}
      {/* Phase section highlight on top arm */}
      <rect x={px0+sLp+Lp*0.2} y={py0-sepP-wp*1.5} width={Lp*0.6} height={wp*3} fill="#d84315" opacity={0.06} stroke="#d84315" strokeWidth={0.5} strokeDasharray="3 2" rx={2}/>
      {sel&&<rect x={px0-3} y={py0-sepP-wp-5} width={totalL+6} height={sep*S+wp*2+10} fill="none" stroke="#0277bd" strokeWidth={1.5} strokeDasharray="5 3" rx={3}/>}
      <text x={px0+totalL/2} y={py0+sepP+wp+12} textAnchor="middle" fill="#1565c0" fontSize={9} fontFamily="monospace" fontWeight={600}>MZI L={L} sep={sep}</text>
    </g></svg>);
  return{svg,pins};
}

// ═══ PHOTONIC BUILDING BLOCK RENDERERS (added above) ═══

// Square spiral delay line renderer - matches IHP design (two interleaved spirals)
function renderSpiral(p,sel,S,rot=0){
  const totalLen = p.total_length || 10000;
  const spc = p.spacing || 10;
  const R = p.min_radius || 100;
  const ww = p.wg_width || 0.7;
  const wp = 2.5;
  
  // Calculate N from total length
  const N = Math.max(1, Math.min(8, Math.round(totalLen / 4000)));
  
  // Fixed display size
  const size = 140 + N * 15;
  const M = 15;
  const gap = 12;  // Gap between interleaved spirals
  
  const pins = [
    {id: "a0", dx: 0, dy: 0, layer: "SiNWG"},
    {id: "b0", dx: size + gap, dy: gap * 2, layer: "SiNWG"}
  ];
  
  // IN spiral (blue) - starts at origin, winds clockwise inward
  const inPts = [];
  let x = M, y = M;
  let w = size, h = size;
  const step = size / (N * 2 + 0.5);
  
  inPts.push([x, y]);
  for (let i = 0; i < N * 2 && w > step && h > step; i++) {
    if (i % 4 === 0) { x += w; }        // Right
    else if (i % 4 === 1) { y += h; }   // Down
    else if (i % 4 === 2) { x -= w; }   // Left
    else { y -= h; }                     // Up
    inPts.push([x, y]);
    if (i % 2 === 0) w -= step; else h -= step;
  }
  
  // OUT spiral (red) - starts offset to right & down, winds clockwise inward (interleaved)
  const outPts = [];
  x = M + gap;
  y = M + gap * 2;
  w = size;
  h = size;
  
  outPts.push([x, y]);
  for (let i = 0; i < N * 2 && w > step && h > step; i++) {
    if (i % 4 === 0) { x += w; }        // Right
    else if (i % 4 === 1) { y += h; }   // Down
    else if (i % 4 === 2) { x -= w; }   // Left
    else { y -= h; }                     // Up
    outPts.push([x, y]);
    if (i % 2 === 0) w -= step; else h -= step;
  }
  
  const inPathD = inPts.map((pt, i) => (i === 0 ? 'M' : 'L') + pt[0].toFixed(1) + ',' + pt[1].toFixed(1)).join(' ');
  const outPathD = outPts.map((pt, i) => (i === 0 ? 'M' : 'L') + pt[0].toFixed(1) + ',' + pt[1].toFixed(1)).join(' ');
  
  const svgW = size + gap * 2 + M * 2;
  const svgH = size + gap * 3 + M * 2 + 20;
  
  const svg = (
    <svg width={svgW} height={svgH} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M}}>
      <g transform={`rotate(${rot},${M},${M})`}>
        {/* Background */}
        <rect x={M-5} y={M-5} width={size+gap*2+10} height={size+gap*3+10} fill="#e8f4fc" opacity={0.35} rx={6}/>
        
        {/* IN spiral - blue */}
        <path d={inPathD} fill="none" stroke="#1565c0" strokeWidth={wp} 
              strokeLinejoin="round" strokeLinecap="round"/>
        
        {/* OUT spiral - red (interleaved) */}
        <path d={outPathD} fill="none" stroke="#d32f2f" strokeWidth={wp} 
              strokeLinejoin="round" strokeLinecap="round"/>
        
        {/* Center connection - sbend */}
        {inPts.length > 2 && outPts.length > 2 && (
          <path d={`M ${inPts[inPts.length-1][0]} ${inPts[inPts.length-1][1]} 
                    Q ${(inPts[inPts.length-1][0] + outPts[outPts.length-1][0])/2} ${(inPts[inPts.length-1][1] + outPts[outPts.length-1][1])/2 + 10}
                    ${outPts[outPts.length-1][0]} ${outPts[outPts.length-1][1]}`}
                fill="none" stroke="#7b1fa2" strokeWidth={wp} strokeDasharray="4 3"/>
        )}
        
        {/* a0 pin at IN spiral start */}
        <circle cx={M} cy={M} r={6} fill="#1565c0" stroke="#fff" strokeWidth={2}/>
        <text x={M-18} y={M+4} fill="#1565c0" fontSize={11} fontWeight="bold">a0</text>
        
        {/* b0 pin at OUT spiral start */}
        <circle cx={M + gap} cy={M + gap*2} r={6} fill="#d32f2f" stroke="#fff" strokeWidth={2}/>
        <text x={M + gap + 10} y={M + gap*2 + 4} fill="#d32f2f" fontSize={11} fontWeight="bold">b0</text>
        
        {/* Selection */}
        {sel && <rect x={M-10} y={M-10} width={size+gap*2+20} height={size+gap*3+30} 
                      fill="none" stroke="#0277bd" strokeWidth={2} strokeDasharray="6 4" rx={6}/>}
        
        {/* Label */}
        <text x={M + size/2 + gap} y={M + size + gap*3 + 15} textAnchor="middle" 
              fill="#0d47a1" fontSize={13} fontFamily="monospace" fontWeight="bold">
          L={totalLen >= 10000 ? (totalLen/10000).toFixed(1)+'cm' : (totalLen/1000).toFixed(1)+'mm'} N={N}
        </text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Text label renderer
function renderTextLabel(p,sel,S,rot=0){
  const h=p.text_height||50, text=p.text||"LABEL";
  const estW=text.length*h*0.6;
  const Wp=estW*S*0.02,Hp=h*S*0.02; // simplified preview
  const M=4,px0=M,py0=M+10;
  const pins=[{id:"a0",dx:0,dy:0,layer:"SiNWG"}];
  const svg=(<svg width={Math.max(estW*S*0.025,60)+M*2} height={30+M*2} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+10)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      <rect x={px0} y={py0-10} width={Math.max(estW*S*0.025,60)} height={20} fill="#546e7a" opacity={0.08} stroke="#546e7a" strokeWidth={0.5} rx={3}/>
      <text x={px0+4} y={py0+4} fill="#37474f" fontSize={12} fontFamily="monospace" fontWeight={700}>{text.length>12?text.slice(0,12)+"…":text}</text>
      {sel&&<rect x={px0-2} y={py0-12} width={Math.max(estW*S*0.025,60)+4} height={24} fill="none" stroke="#546e7a" strokeWidth={1.5} strokeDasharray="5 3" rx={4}/>}
    </g></svg>);
  return{svg,pins};
}

// GSG Pad renderer
function renderGSGPad(p,sel,S,rot=0){
  const pw=p.pad_width||80,ph=p.pad_height||80,gap=p.pad_gap||50,wg=p.wg_width||0.7;
  const pW=pw*S,pH=ph*S,gP=gap*S,wp=Math.max(wg*S,1.5),M=4;
  const totalW=pW*3+gP*2;
  const px0=M,py0=M+pH/2;
  const pins=[
    {id:"gnd_l",dx:pw/2,dy:0,layer:"GM1"},
    {id:"sig",dx:pw+gap+pw/2,dy:0,layer:"GM1"},
    {id:"gnd_r",dx:pw*2+gap*2+pw/2,dy:0,layer:"GM1"},
  ];
  const svg=(<svg width={totalW+M*2} height={pH+M*2+14} style={{overflow:"visible",display:"block",marginLeft:-M,marginTop:-(M+pH/2)}}>
    <g transform={`rotate(${rot},${px0},${py0})`}>
      {/* Ground left */}
      <rect x={px0} y={py0-pH/2} width={pW} height={pH} fill="#d84315" opacity={0.15} stroke="#d84315" strokeWidth={1} rx={2}/>
      <text x={px0+pW/2} y={py0+3} textAnchor="middle" fill="#d84315" fontSize={9} fontWeight={700}>G</text>
      {/* Signal */}
      <rect x={px0+pW+gP} y={py0-pH/2} width={pW} height={pH} fill="#d84315" opacity={0.25} stroke="#d84315" strokeWidth={1.5} rx={2}/>
      <text x={px0+pW+gP+pW/2} y={py0+3} textAnchor="middle" fill="#d84315" fontSize={9} fontWeight={700}>S</text>
      {/* Ground right */}
      <rect x={px0+pW*2+gP*2} y={py0-pH/2} width={pW} height={pH} fill="#d84315" opacity={0.15} stroke="#d84315" strokeWidth={1} rx={2}/>
      <text x={px0+pW*2+gP*2+pW/2} y={py0+3} textAnchor="middle" fill="#d84315" fontSize={9} fontWeight={700}>G</text>
      {sel&&<rect x={px0-3} y={py0-pH/2-3} width={totalW+6} height={pH+6} fill="none" stroke="#d84315" strokeWidth={1.5} strokeDasharray="5 3" rx={4}/>}
      <text x={px0+totalW/2} y={py0+pH/2+11} textAnchor="middle" fill="#d84315" fontSize={9} fontFamily="monospace" fontWeight={600}>GSG Pad</text>
    </g></svg>);
  return{svg,pins};
}

// ═══ NEW COMPONENT RENDERERS ═══

// Euler Bend renderer
function renderEulerBend(p,sel,S,rot=0){
  const angle = p.angle || 90;
  const R = p.radius || 100;
  const ww = p.wg_width || 0.7;
  const M = 8;
  const sc = Math.min(S * 0.8, 0.6);
  const wp = Math.max(ww * sc * 3, 2);
  
  // Euler bend has gradual curvature change
  const size = R * sc * 1.5;
  const endX = R * sc * Math.cos((90 - angle) * Math.PI / 180);
  const endY = R * sc * Math.sin(angle * Math.PI / 180);
  
  const pins = [
    {id: "a0", dx: 0, dy: 0, layer: "SiNWG"},
    {id: "b0", dx: R * (1 - Math.cos(angle * Math.PI / 180)), dy: R * Math.sin(angle * Math.PI / 180), layer: "SiNWG"}
  ];
  
  // Draw clothoid-like curve
  const pathD = `M ${M} ${M + size} Q ${M + size * 0.3} ${M + size * 0.7} ${M + size * 0.8} ${M + size * 0.2}`;
  
  const svg = (
    <svg width={size + M*2 + 30} height={size + M*2 + 20} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M}}>
      <g transform={`rotate(${rot},${M},${M + size})`}>
        <rect x={M-3} y={M-3} width={size+36} height={size+16} fill="#e8f5e9" opacity={0.3} rx={4}/>
        <path d={pathD} fill="none" stroke="#2e7d32" strokeWidth={wp} strokeLinecap="round"/>
        <circle cx={M} cy={M + size} r={4} fill="#2e7d32" stroke="#fff" strokeWidth={1.5}/>
        <circle cx={M + size * 0.8} cy={M + size * 0.2} r={4} fill="#2e7d32" stroke="#fff" strokeWidth={1.5}/>
        {sel && <rect x={M-6} y={M-6} width={size+42} height={size+22} fill="none" stroke="#2e7d32" strokeWidth={2} strokeDasharray="5 3" rx={4}/>}
        <text x={M + size/2 + 15} y={M + size + 12} textAnchor="middle" fill="#2e7d32" fontSize={10} fontWeight="bold">Euler {angle}°</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Cobra Curve renderer
function renderCobraCurve(p,sel,S,rot=0){
  const endX = p.end_x || 200;
  const endY = p.end_y || 100;
  const ww = p.wg_width || 0.7;
  const M = 10;
  const sc = Math.min(S * 0.5, 0.4);
  const wp = Math.max(ww * sc * 3, 2);
  
  const dispX = endX * sc;
  const dispY = endY * sc;
  
  const pins = [
    {id: "a0", dx: 0, dy: 0, layer: "SiNWG"},
    {id: "b0", dx: endX, dy: endY, layer: "SiNWG"}
  ];
  
  // Smooth S-curve
  const pathD = `M ${M} ${M} C ${M + dispX * 0.5} ${M} ${M + dispX * 0.5} ${M + dispY} ${M + dispX} ${M + dispY}`;
  
  const svg = (
    <svg width={dispX + M*2 + 20} height={dispY + M*2 + 20} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M}}>
      <g transform={`rotate(${rot},${M},${M})`}>
        <rect x={M-3} y={M-3} width={dispX+26} height={dispY+16} fill="#fff3e0" opacity={0.3} rx={4}/>
        <path d={pathD} fill="none" stroke="#e65100" strokeWidth={wp} strokeLinecap="round"/>
        <circle cx={M} cy={M} r={4} fill="#e65100" stroke="#fff" strokeWidth={1.5}/>
        <text x={M+8} y={M+4} fill="#e65100" fontSize={9} fontWeight="bold">a0</text>
        <circle cx={M + dispX} cy={M + dispY} r={4} fill="#e65100" stroke="#fff" strokeWidth={1.5}/>
        <text x={M + dispX + 8} y={M + dispY + 4} fill="#e65100" fontSize={9} fontWeight="bold">b0</text>
        {sel && <rect x={M-6} y={M-6} width={dispX+32} height={dispY+22} fill="none" stroke="#e65100" strokeWidth={2} strokeDasharray="5 3" rx={4}/>}
        <text x={M + dispX/2} y={M + dispY + 15} textAnchor="middle" fill="#e65100" fontSize={10} fontWeight="bold">Cobra</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// DBR Grating renderer
function renderDBR(p,sel,S,rot=0){
  const period = p.period || 0.32;
  const numP = p.num_periods || 100;
  const ww = p.wg_width || 0.7;
  const dw = p.delta_w || 0.1;
  const M = 8;
  
  const totalL = period * numP;
  const dispL = Math.min(totalL * S * 0.3, 150);
  const dispH = 30;
  const numBars = Math.min(numP, 20);
  
  const pins = [
    {id: "a0", dx: 0, dy: 0, layer: "SiNWG"},
    {id: "b0", dx: totalL, dy: 0, layer: "SiNWG"}
  ];
  
  const svg = (
    <svg width={dispL + M*2 + 20} height={dispH + M*2 + 16} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M - dispH/2}}>
      <g transform={`rotate(${rot},${M},${M + dispH/2})`}>
        <rect x={M-3} y={M-3} width={dispL+26} height={dispH+6} fill="#e1f5fe" opacity={0.4} rx={4}/>
        {/* Grating bars */}
        {Array.from({length: numBars}, (_, i) => (
          <rect key={i} x={M + i * dispL / numBars} y={M + (i % 2 === 0 ? 2 : 5)} 
                width={dispL / numBars * 0.4} height={dispH - (i % 2 === 0 ? 4 : 10)} 
                fill="#0277bd" opacity={0.7}/>
        ))}
        <circle cx={M} cy={M + dispH/2} r={4} fill="#0277bd" stroke="#fff" strokeWidth={1.5}/>
        <circle cx={M + dispL} cy={M + dispH/2} r={4} fill="#0277bd" stroke="#fff" strokeWidth={1.5}/>
        {sel && <rect x={M-6} y={M-6} width={dispL+32} height={dispH+12} fill="none" stroke="#0277bd" strokeWidth={2} strokeDasharray="5 3" rx={4}/>}
        <text x={M + dispL/2} y={M + dispH + 12} textAnchor="middle" fill="#0277bd" fontSize={10} fontWeight="bold">DBR {numP}×</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Photonic Crystal renderer
function renderPhotonicCrystal(p,sel,S,rot=0){
  const rows = p.rows || 5;
  const cols = p.cols || 10;
  const holeR = p.hole_radius || 0.15;
  const pitchX = p.pitch_x || 0.45;
  const pitchY = p.pitch_y || 0.45;
  const lattice = p.lattice || 'square';
  const M = 10;
  
  const dispW = cols * 8;
  const dispH = rows * 8;
  const hR = 3;
  
  const pins = [
    {id: "a0", dx: 0, dy: rows * pitchY / 2, layer: "SiNWG"},
    {id: "b0", dx: cols * pitchX, dy: rows * pitchY / 2, layer: "SiNWG"}
  ];
  
  const holes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = M + c * 8 + (lattice === 'hexagonal' && r % 2 ? 4 : 0);
      const y = M + r * (lattice === 'hexagonal' ? 7 : 8);
      holes.push(<circle key={`${r}-${c}`} cx={x} cy={y} r={hR} fill="#303f9f" opacity={0.6}/>);
    }
  }
  
  const svg = (
    <svg width={dispW + M*2 + 20} height={dispH + M*2 + 20} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M}}>
      <g transform={`rotate(${rot},${M},${M})`}>
        <rect x={M-5} y={M-5} width={dispW+30} height={dispH+10} fill="#e8eaf6" opacity={0.4} rx={4}/>
        {holes}
        {sel && <rect x={M-8} y={M-8} width={dispW+36} height={dispH+16} fill="none" stroke="#303f9f" strokeWidth={2} strokeDasharray="5 3" rx={4}/>}
        <text x={M + dispW/2 + 10} y={M + dispH + 14} textAnchor="middle" fill="#303f9f" fontSize={10} fontWeight="bold">PhC {rows}×{cols}</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Custom Polygon renderer
function renderCustomPolygon(p,sel,S,rot=0){
  let points;
  try {
    points = typeof p.points === 'string' ? JSON.parse(p.points) : p.points;
  } catch { points = [[0,0],[100,0],[100,50],[50,80],[0,50]]; }
  
  const M = 10;
  const xs = points.map(pt => pt[0]);
  const ys = points.map(pt => pt[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  const sc = Math.min(100 / w, 100 / h, 1);
  
  const polyPts = points.map(pt => `${M + (pt[0] - minX) * sc},${M + (pt[1] - minY) * sc}`).join(' ');
  
  const pins = [
    {id: "a0", dx: minX, dy: (minY + maxY) / 2, layer: "SiNWG"},
    {id: "b0", dx: maxX, dy: (minY + maxY) / 2, layer: "SiNWG"}
  ];
  
  // Use original_name if imported, otherwise "Polygon"
  const label = p.original_name || (p.imported ? "Imported" : "Polygon");
  const shortLabel = label.length > 12 ? label.slice(0, 12) + "…" : label;
  
  const svg = (
    <svg width={w * sc + M*2 + 20} height={h * sc + M*2 + 20} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M}}>
      <g transform={`rotate(${rot},${M},${M})`}>
        <polygon points={polyPts} fill="#7b1fa2" opacity={0.3} stroke="#7b1fa2" strokeWidth={2}/>
        {sel && <rect x={M-5} y={M-5} width={w*sc+30} height={h*sc+10} fill="none" stroke="#7b1fa2" strokeWidth={2} strokeDasharray="5 3" rx={4}/>}
        <text x={M + w*sc/2 + 10} y={M + h*sc + 14} textAnchor="middle" fill="#7b1fa2" fontSize={9} fontWeight="bold">{shortLabel}</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Square Array renderer
function renderSquareArray(p,sel,S,rot=0){
  const rows = p.rows || 5;
  const cols = p.cols || 5;
  const elW = p.element_width || 10;
  const elH = p.element_height || 10;
  const pitchX = p.pitch_x || 20;
  const pitchY = p.pitch_y || 20;
  const M = 10;
  
  // Display size
  const totalW = (cols - 1) * pitchX + elW;
  const totalH = (rows - 1) * pitchY + elH;
  const sc = Math.min(120 / totalW, 120 / totalH, 0.8);
  const dispW = totalW * sc;
  const dispH = totalH * sc;
  const elWs = elW * sc;
  const elHs = elH * sc;
  const pXs = pitchX * sc;
  const pYs = pitchY * sc;
  
  const pins = [
    {id: "a0", dx: -elW/2, dy: (rows-1)*pitchY/2, layer: "SiNWG"},
    {id: "b0", dx: (cols-1)*pitchX + elW/2, dy: (rows-1)*pitchY/2, layer: "SiNWG"},
    {id: "center", dx: (cols-1)*pitchX/2, dy: (rows-1)*pitchY/2, layer: "SiNWG"}
  ];
  
  const rects = [];
  const maxDraw = 6; // limit display for performance
  const rowStep = rows > maxDraw ? Math.ceil(rows / maxDraw) : 1;
  const colStep = cols > maxDraw ? Math.ceil(cols / maxDraw) : 1;
  
  for (let r = 0; r < rows; r += rowStep) {
    for (let c = 0; c < cols; c += colStep) {
      const x = M + c * pXs;
      const y = M + r * pYs;
      rects.push(
        <rect key={`${r}-${c}`} x={x} y={y} width={elWs} height={elHs} 
              fill="#00897b" opacity={0.5} stroke="#00897b" strokeWidth={0.5}/>
      );
    }
  }
  
  const svg = (
    <svg width={dispW + M*2 + 20} height={dispH + M*2 + 20} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M}}>
      <g transform={`rotate(${rot},${M},${M})`}>
        <rect x={M-5} y={M-5} width={dispW+30} height={dispH+10} fill="#e0f2f1" opacity={0.3} rx={4}/>
        {rects}
        {sel && <rect x={M-8} y={M-8} width={dispW+36} height={dispH+16} fill="none" stroke="#00897b" strokeWidth={2} strokeDasharray="5 3" rx={4}/>}
        <text x={M + dispW/2 + 10} y={M + dispH + 14} textAnchor="middle" fill="#00897b" fontSize={10} fontWeight="bold">{rows}×{cols} Array</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Circular Array renderer
function renderCircularArray(p,sel,S,rot=0){
  const numLayers = p.num_layers || 1;
  const radius = p.radius || 100;
  const layerSpacing = p.layer_spacing || 20;
  const angularSpacing = p.angular_spacing || 0;
  const arcSpacing = p.arc_spacing || 0;  // 0 = use num_elements
  const numElParam = p.num_elements || 8;
  const startAng = p.start_angle || 0;
  const endAng = p.end_angle || 360;
  const elW = p.element_width || 10;
  const elH = p.element_height || 10;
  const elShape = p.element_shape || 'rectangle';
  const rotateEl = p.rotate_elements !== false;
  const M = 15;
  
  // Outer radius includes all layers
  const outerRadius = radius + (numLayers - 1) * layerSpacing;
  
  // Display size
  const totalSize = (outerRadius + elW) * 2;
  const sc = Math.min(140 / totalSize, 0.5);
  const elWs = elW * sc;
  const elHs = elH * sc;
  const layerSpacingSc = layerSpacing * sc;
  const innerDispR = radius * sc;
  const outerDispR = outerRadius * sc;
  const cx = M + outerDispR + elWs/2;
  const cy = M + outerDispR + elHs/2;
  
  const pins = [
    {id: "a0", dx: -outerRadius - elW/2, dy: 0, layer: "SiNWG"},
    {id: "b0", dx: outerRadius + elW/2, dy: 0, layer: "SiNWG"},
    {id: "center", dx: 0, dy: 0, layer: "SiNWG"}
  ];
  
  const elements = [];
  const refCircles = [];
  
  // Draw each layer
  let totalElements = 0;
  for (let layerIdx = 0; layerIdx < numLayers; layerIdx++) {
    const currentRReal = radius + layerIdx * layerSpacing;
    const currentR = innerDispR + layerIdx * layerSpacingSc;
    const layerAngOffset = layerIdx * angularSpacing;
    const opacity = 0.3 + 0.4 * (layerIdx / Math.max(numLayers - 1, 1));
    
    // Calculate num elements for this ring
    let numEl;
    if (arcSpacing > 0) {
      const arcLength = currentRReal * (endAng - startAng) * Math.PI / 180;
      numEl = Math.max(1, Math.floor(arcLength / arcSpacing));
    } else {
      numEl = numElParam;
    }
    totalElements += numEl;
    
    const angleStep = numEl > 1 ? 
      (endAng - startAng >= 360 ? 360 / numEl : (endAng - startAng) / (numEl - 1)) : 0;
    
    // Reference circle for this layer
    refCircles.push(
      <circle key={`ref-${layerIdx}`} cx={cx} cy={cy} r={currentR} 
              fill="none" stroke="#d81b60" strokeWidth={0.5} strokeDasharray="3 2" opacity={0.3}/>
    );
    
    for (let i = 0; i < numEl; i++) {
      const ang = (startAng + i * angleStep + layerAngOffset) * Math.PI / 180;
      const x = cx + currentR * Math.cos(ang);
      const y = cy + currentR * Math.sin(ang);
      
      if (elShape === 'circle') {
        elements.push(
          <circle key={`${layerIdx}-${i}`} cx={x} cy={y} r={elWs/2} 
                  fill="#d81b60" opacity={opacity} stroke="#d81b60" strokeWidth={0.5}/>
        );
      } else {
        const rotAngle = rotateEl ? (startAng + i * angleStep + layerAngOffset + 90) : 0;
        elements.push(
          <rect key={`${layerIdx}-${i}`} x={x - elWs/2} y={y - elHs/2} width={elWs} height={elHs}
                fill="#d81b60" opacity={opacity} stroke="#d81b60" strokeWidth={0.5}
                transform={`rotate(${rotAngle},${x},${y})`}/>
        );
      }
    }
  }
  
  const svg = (
    <svg width={(outerDispR + elWs/2) * 2 + M*2 + 10} height={(outerDispR + elHs/2) * 2 + M*2 + 20} 
         style={{overflow: "visible", display: "block", marginLeft: -M - outerDispR - elWs/2, marginTop: -M - outerDispR - elHs/2}}>
      <g transform={`rotate(${rot},${cx},${cy})`}>
        {/* Reference circles for each layer */}
        {refCircles}
        {/* Center dot */}
        <circle cx={cx} cy={cy} r={2} fill="#d81b60" opacity={0.5}/>
        {/* Elements */}
        {elements}
        {/* Arc indicator */}
        {endAng - startAng < 360 && (
          <path d={`M ${cx + outerDispR * 0.3 * Math.cos(startAng * Math.PI/180)} ${cy + outerDispR * 0.3 * Math.sin(startAng * Math.PI/180)} 
                    A ${outerDispR * 0.3} ${outerDispR * 0.3} 0 ${endAng - startAng > 180 ? 1 : 0} 1 
                    ${cx + outerDispR * 0.3 * Math.cos(endAng * Math.PI/180)} ${cy + outerDispR * 0.3 * Math.sin(endAng * Math.PI/180)}`}
                fill="none" stroke="#d81b60" strokeWidth={1} opacity={0.3}/>
        )}
        {sel && <circle cx={cx} cy={cy} r={outerDispR + elWs/2 + 8} fill="none" stroke="#d81b60" strokeWidth={2} strokeDasharray="5 3"/>}
        <text x={cx} y={cy + outerDispR + elHs/2 + 14} textAnchor="middle" fill="#d81b60" fontSize={9} fontWeight="bold">
          {numLayers > 1 ? `${numLayers}L ` : ''}{arcSpacing > 0 ? `s=${arcSpacing}µm` : `n=${numElParam}`} r={radius}
        </text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Arc Trapezoid renderer (curved trapezoid with arc edges)
function renderArcTrapezoid(p, sel, S, rot=0) {
  const outerR = p.outer_radius || 100;
  const innerR = p.inner_radius || 50;
  const angle = p.angle || 90;
  const outerW = p.outer_width || 10;
  const innerW = p.inner_width || 5;
  const innerStyle = p.inner_style || 'arc';
  const c = shapeColor(p.layer);
  const op = 0.3;
  const M = 10;
  
  const sc = Math.min(100 / (outerR + outerW), 0.5);
  const outerRs = outerR * sc;
  const innerRs = innerR * sc;
  const outerWs = outerW * sc;
  const innerWs = innerW * sc;
  const outerRout = outerRs + outerWs/2;
  const innerRout = innerRs + innerWs/2;
  const cx = M + outerRout;
  const cy = M + outerRout;
  
  const rad = d => d * Math.PI / 180;
  
  // Build path in standard coords
  let pathD = '';
  const N = Math.max(Math.floor(Math.abs(angle) / 5), 8);
  
  // Outer arc (0 to angle)
  for (let i = 0; i <= N; i++) {
    const a = rad(angle * i / N);
    const x = cx + outerRout * Math.cos(a);
    const y = cy - outerRout * Math.sin(a);
    pathD += (i === 0 ? 'M' : 'L') + `${x},${y} `;
  }
  
  // Inner edge (angle back to 0)
  if (innerStyle === 'flat' || innerR <= 0) {
    if (innerR > 0) {
      const endA = rad(angle);
      pathD += `L${cx + innerRout * Math.cos(endA)},${cy - innerRout * Math.sin(endA)} `;
      pathD += `L${cx + innerRout},${cy} `;
    } else {
      pathD += `L${cx},${cy} `;
    }
  } else {
    for (let i = N; i >= 0; i--) {
      const a = rad(angle * i / N);
      const x = cx + innerRout * Math.cos(a);
      const y = cy - innerRout * Math.sin(a);
      pathD += `L${x},${y} `;
    }
  }
  pathD += 'Z';
  
  const midR = (outerR + innerR) / 2;
  const pins = [
    {id: "a0", dx: midR, dy: 0, layer: p.layer || "SiNWG"},
    {id: "b0", dx: midR * Math.cos(rad(angle)), dy: -midR * Math.sin(rad(angle)), layer: p.layer || "SiNWG"},
    {id: "center", dx: 0, dy: 0, layer: p.layer || "SiNWG"}
  ];
  
  // Add 90° to rotation to match GDS preview visually
  const visualRot = rot + 180;
  
  const svg = (
    <svg width={outerRout * 2 + M * 2 + 10} height={outerRout * 2 + M * 2 + 20} 
         style={{overflow: "visible", display: "block", marginLeft: -cx, marginTop: -cy}}>
      <g transform={`rotate(${visualRot},${cx},${cy})`}>
        <circle cx={cx} cy={cy} r={2} fill={c} opacity={0.4}/>
        <path d={pathD} fill={c} opacity={op} stroke={c} strokeWidth={1}/>
        <circle cx={cx + outerRout} cy={cy} r={3} fill={c} stroke="#fff" strokeWidth={1}/>
        <circle cx={cx + outerRout * Math.cos(rad(angle))} cy={cy - outerRout * Math.sin(rad(angle))} r={3} fill={c} stroke="#fff" strokeWidth={1}/>
        {sel && <circle cx={cx} cy={cy} r={outerRout + 5} fill="none" stroke={c} strokeWidth={2} strokeDasharray="5 3"/>}
        <text x={cx} y={cy + outerRout + 14} textAnchor="middle" fill={c} fontSize={9} fontWeight="bold" transform={`rotate(${-visualRot},${cx},${cy + outerRout + 14})`}>
          ArcTrap {angle}°
        </text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Sine Bend renderer
function renderSineBend(p,sel,S,rot=0){
  const dist = p.distance || 100;
  const offset = p.offset || 50;
  const ww = p.wg_width || 0.7;
  const M = 10;
  const sc = Math.min(S * 0.6, 0.5);
  const wp = Math.max(ww * sc * 3, 2);
  
  const dispW = dist * sc;
  const dispH = Math.abs(offset) * sc;
  
  const pins = [
    {id: "a0", dx: 0, dy: 0, layer: "SiNWG"},
    {id: "b0", dx: dist, dy: offset, layer: "SiNWG"}
  ];
  
  // Sine curve S-bend
  const pathD = `M ${M} ${M} C ${M + dispW * 0.3} ${M} ${M + dispW * 0.7} ${M + dispH} ${M + dispW} ${M + dispH}`;
  
  const svg = (
    <svg width={dispW + M*2 + 20} height={dispH + M*2 + 20} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M}}>
      <g transform={`rotate(${rot},${M},${M})`}>
        <rect x={M-3} y={M-3} width={dispW+26} height={dispH+16} fill="#f3e5f5" opacity={0.3} rx={4}/>
        <path d={pathD} fill="none" stroke="#8e24aa" strokeWidth={wp} strokeLinecap="round"/>
        <circle cx={M} cy={M} r={4} fill="#8e24aa" stroke="#fff" strokeWidth={1.5}/>
        <circle cx={M + dispW} cy={M + dispH} r={4} fill="#8e24aa" stroke="#fff" strokeWidth={1.5}/>
        {sel && <rect x={M-6} y={M-6} width={dispW+32} height={dispH+22} fill="none" stroke="#8e24aa" strokeWidth={2} strokeDasharray="5 3" rx={4}/>}
        <text x={M + dispW/2} y={M + dispH + 15} textAnchor="middle" fill="#8e24aa" fontSize={10} fontWeight="bold">Sine Bend</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Tapered Bend renderer
function renderTaperedBend(p,sel,S,rot=0){
  const angle = p.angle || 90;
  const R = p.radius || 100;
  const w1 = p.width1 || 0.5;
  const w2 = p.width2 || 2.0;
  const M = 10;
  const sc = Math.min(S * 0.5, 0.4);
  
  const size = R * sc * 1.2;
  
  const pins = [
    {id: "a0", dx: 0, dy: 0, layer: "SiNWG"},
    {id: "b0", dx: R * (1 - Math.cos(angle * Math.PI / 180)), dy: R * Math.sin(angle * Math.PI / 180), layer: "SiNWG"}
  ];
  
  const svg = (
    <svg width={size + M*2 + 30} height={size + M*2 + 20} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M}}>
      <g transform={`rotate(${rot},${M},${M + size})`}>
        <rect x={M-3} y={M-3} width={size+36} height={size+16} fill="#fff8e1" opacity={0.3} rx={4}/>
        {/* Tapered arc - drawn as path with varying width */}
        <path d={`M ${M} ${M + size} Q ${M + size * 0.5} ${M + size * 0.3} ${M + size} ${M}`} 
              fill="none" stroke="#f57c00" strokeWidth={w1 * sc * 8} strokeLinecap="round" opacity={0.5}/>
        <path d={`M ${M} ${M + size} Q ${M + size * 0.5} ${M + size * 0.3} ${M + size} ${M}`} 
              fill="none" stroke="#f57c00" strokeWidth={2} strokeLinecap="round"/>
        <circle cx={M} cy={M + size} r={4} fill="#f57c00" stroke="#fff" strokeWidth={1.5}/>
        <circle cx={M + size} cy={M} r={5} fill="#f57c00" stroke="#fff" strokeWidth={1.5}/>
        {sel && <rect x={M-6} y={M-6} width={size+42} height={size+22} fill="none" stroke="#f57c00" strokeWidth={2} strokeDasharray="5 3" rx={4}/>}
        <text x={M + size/2 + 15} y={M + size + 12} textAnchor="middle" fill="#f57c00" fontSize={10} fontWeight="bold">Taper Bend</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Image Layer renderer
function renderImageLayer(p,sel,S,rot=0){
  const width = p.width || 500;
  const height = p.height || 500;
  const imageUrl = p.image_url || '';
  const opacity = p.opacity || 0.5;
  const M = 10;
  const sc = Math.min(150 / Math.max(width, height), 0.4);
  const dispW = width * sc;
  const dispH = height * sc;
  
  const pins = [
    {id: "a0", dx: 0, dy: 0, layer: "Alignment"},
    {id: "b0", dx: width, dy: 0, layer: "Alignment"},
    {id: "center", dx: width/2, dy: 0, layer: "Alignment"}
  ];
  
  const svg = (
    <svg width={dispW + M*2 + 20} height={dispH + M*2 + 20} style={{overflow: "visible", display: "block", marginLeft: -M, marginTop: -M - dispH/2}}>
      <g transform={`rotate(${rot},${M},${M + dispH/2})`}>
        <rect x={M} y={M} width={dispW} height={dispH} fill="#eceff1" stroke="#607d8b" strokeWidth={2} strokeDasharray={imageUrl ? "0" : "8 4"} rx={4}/>
        {imageUrl ? (
          <image href={imageUrl} x={M} y={M} width={dispW} height={dispH} preserveAspectRatio="xMidYMid meet" opacity={opacity}/>
        ) : (
          <>
            <line x1={M} y1={M} x2={M + dispW} y2={M + dispH} stroke="#90a4ae" strokeWidth={1}/>
            <line x1={M + dispW} y1={M} x2={M} y2={M + dispH} stroke="#90a4ae" strokeWidth={1}/>
            <text x={M + dispW/2} y={M + dispH/2 - 6} textAnchor="middle" fill="#607d8b" fontSize={11}>📷</text>
            <text x={M + dispW/2} y={M + dispH/2 + 8} textAnchor="middle" fill="#607d8b" fontSize={9}>Upload Image</text>
          </>
        )}
        {/* Pins */}
        <circle cx={M} cy={M + dispH/2} r={4} fill="#607d8b" stroke="#fff" strokeWidth={1.5}/>
        <circle cx={M + dispW} cy={M + dispH/2} r={4} fill="#607d8b" stroke="#fff" strokeWidth={1.5}/>
        {sel && <rect x={M-5} y={M-5} width={dispW+10} height={dispH+10} fill="none" stroke="#607d8b" strokeWidth={2} strokeDasharray="5 3" rx={4}/>}
        <text x={M + dispW/2} y={M + dispH + 14} textAnchor="middle" fill="#607d8b" fontSize={9} fontWeight="bold">{width}×{height} µm</text>
      </g>
    </svg>
  );
  return {svg, pins};
}

// Component groups for organized left panel
const COMP_GROUPS=[
  {id:"waveguides",label:"🔹 Waveguides & Coupling",desc:"Optical routing and light coupling",
    types:["grating_coupler","ssc","y_junction","directional_coupler","mmi_splitter","mmi_splitter_poly","spiral_delay"]},
  {id:"bends",label:"〰️ Bends & Curves",desc:"Waveguide bends and routing curves",
    types:["euler_bend","sine_bend","tapered_bend"]},
  {id:"modulators",label:"⚡ Modulators & Actives",desc:"Electro-optic modulation",
    types:["straight_eam","phase_modulator","mzi"]},
  {id:"resonators",label:"🔴 Resonators",desc:"Ring and racetrack resonators",
    types:["ring_resonator","racetrack_resonator"]},
  {id:"gratings",label:"📶 Gratings & PhC",desc:"Periodic structures",
    types:["dbr_grating","photonic_crystal"]},
  {id:"arrays",label:"⊞ Arrays & Patterns",desc:"Arrayed element patterns",
    types:["square_array","circular_array"]},
  {id:"pads",label:"📌 Pads & Contacts",desc:"Electrical contacts and bond pads",
    types:["bond_pad","gsg_pad"]},
  {id:"shapes",label:"🔷 Geometry Shapes",desc:"nazca.geometries polygon primitives",
    types:["geo_rectangle","geo_circle","geo_ring","geo_arc","geo_taper","geo_trapezoid","geo_parallelogram","geo_rhombus","geo_rounded_rect","geo_frame","geo_pie","geo_tetragon","arc_trapezoid","custom_polygon"]},
  {id:"misc",label:"🏷️ Labels & Images",desc:"Text labels, images, alignment marks",
    types:["text_label","image_layer"]},
];

// ═══ COMPONENT REGISTRY ═══
const DEFS={
  grating_coupler:{label:"Grating Coupler",icon:"⫠",color:"#0277bd",desc:"Fiber-to-chip optical coupling via diffraction grating",
    defaultParams:{period:0.92,tp_width:10,ff:0.511,taper_len:250,wg_width:0.7},
    paramLabels:{period:"Period (µm)",tp_width:"Taper width",ff:"Fill factor",taper_len:"Taper length",wg_width:"WG width"},
    render:renderGC},
  straight_eam:{label:"Straight EAM",icon:"▬",color:"#2e7d32",desc:"Graphene electro-absorption modulator",
    defaultParams:{wg_width:0.7,gr_length:200,gr_width:8,wg_extra:100,gm1_offset:1.7,pass_overlap:0.2,via_size:0.36,via_gap:0.36,via_rows:4,via_row_spacing:0.72,via_length:200,via_start_offset:0},
    paramGroups:[{label:"Optical",keys:["wg_width","wg_extra","pass_overlap"]},{label:"Graphene",keys:["gr_length","gr_width","gm1_offset"]},{label:"Vias",keys:["via_size","via_gap","via_rows","via_row_spacing","via_length","via_start_offset"]}],
    paramLabels:{wg_width:"WG width",gr_length:"Gr. length",gr_width:"Gr. width",wg_extra:"Extra WG",gm1_offset:"GM1 offset",pass_overlap:"Pass. overlap",via_size:"Via size",via_gap:"Via gap",via_rows:"Via rows",via_row_spacing:"Row spacing",via_length:"Via length",via_start_offset:"Via offset"},
    render:renderEAM},
  ring_resonator:{label:"Ring Resonator",icon:"◎",color:"#c62828",desc:"Graphene ring modulator with contact pads",
    defaultParams:{radius:60,gap:0.34,wg_width:0.7,gr_length:10,gr_width:7.7,gm1_width:20,via_size:0.5,via_gap:0.4,layer_spacing:0.8,pad_size:80,pad_open_factor:0.4,pad_distance:0.15},
    paramGroups:[{label:"Optical",keys:["radius","gap","wg_width"]},{label:"Graphene",keys:["gr_length","gr_width","gm1_width"]},{label:"Vias",keys:["via_size","via_gap","layer_spacing"]},{label:"Pad",keys:["pad_size","pad_open_factor","pad_distance"]}],
    paramLabels:{radius:"Radius",gap:"Gap",wg_width:"WG width",gr_length:"Gr. arc",gr_width:"Gr. width",gm1_width:"GM1 ch.",via_size:"Via size",via_gap:"Via gap",layer_spacing:"Layer sp.",pad_size:"Pad size",pad_open_factor:"Open frac.",pad_distance:"Pad dist."},
    render:renderRing},
  racetrack_resonator:{label:"Racetrack Resonator",icon:"⬭",color:"#c62828",desc:"Graphene racetrack modulator with straight coupling section",
    defaultParams:{radius:60,gap:0.34,wg_width:0.7,coupling_length:20,gr_length:10,gr_width:7.7,gm1_width:20,via_size:0.5,via_gap:0.4,layer_spacing:0.8,pad_size:80,pad_open_factor:0.4,pad_distance:0.15},
    paramGroups:[{label:"Optical",keys:["radius","gap","wg_width","coupling_length"]},{label:"Graphene",keys:["gr_length","gr_width","gm1_width"]},{label:"Vias",keys:["via_size","via_gap","layer_spacing"]},{label:"Pad",keys:["pad_size","pad_open_factor","pad_distance"]}],
    paramLabels:{radius:"Radius",gap:"Gap",wg_width:"WG width",coupling_length:"Coupling L",gr_length:"Gr. arc",gr_width:"Gr. width",gm1_width:"GM1 ch.",via_size:"Via size",via_gap:"Via gap",layer_spacing:"Layer sp.",pad_size:"Pad size",pad_open_factor:"Open frac.",pad_distance:"Pad dist."},
    render:renderRacetrack},
  bond_pad:{label:"Bond Pad",icon:"□",color:"#00695c",desc:"Rectangular bond pad (GM1+GCT)",
    defaultParams:{pad_length:80,pad_width:80,open_factor:0.4},
    paramLabels:{pad_length:"Length",pad_width:"Width",open_factor:"Open fraction"},
    render:renderPad},
  gsg_pad:{label:"GSG Pad",icon:"⫿",color:"#bf360c",desc:"Ground-Signal-Ground RF probe pad",
    defaultParams:{pad_width:80,pad_height:80,pad_gap:50,wg_width:0.7},
    paramLabels:{pad_width:"Pad width",pad_height:"Pad height",pad_gap:"Gap",wg_width:"WG width"},
    render:renderGSGPad},
  mmi_splitter:{label:"MMI Splitter",icon:"⊟",color:"#0d47a1",desc:"Multi-mode interference N×M splitter (flat rectangular)",
    defaultParams:{mmi_length:50,mmi_width:12,wg_width:0.7,num_inputs:1,num_outputs:2,mmi_style:"flat"},
    paramLabels:{mmi_length:"MMI length (µm)",mmi_width:"MMI width (µm)",wg_width:"WG width (µm)",num_inputs:"Num inputs",num_outputs:"Num outputs"},
    render:renderMMI},
  mmi_splitter_poly:{label:"MMI Splitter (Poly)",icon:"⊟",color:"#0d47a1",desc:"Multi-mode interference N×M splitter (tapered/poly)",
    defaultParams:{mmi_length:50,mmi_width:12,wg_width:0.7,num_inputs:1,num_outputs:2,mmi_style:"poly"},
    paramLabels:{mmi_length:"MMI length (µm)",mmi_width:"MMI width (µm)",wg_width:"WG width (µm)",num_inputs:"Num inputs",num_outputs:"Num outputs"},
    render:renderMMI},
  spiral_delay:{label:"Spiral Delay Line",icon:"⌘",color:"#0d47a1",desc:"Square spiral - specify total length, auto-calculates turns",
    defaultParams:{total_length:10000,spacing:10,min_radius:100,wg_width:0.7},
    paramGroups:[{label:"Length",keys:["total_length"]},{label:"Waveguide",keys:["wg_width","min_radius","spacing"]}],
    paramLabels:{total_length:"Total length (µm)",spacing:"Spacing (µm)",min_radius:"Bend radius (µm)",wg_width:"WG width (µm)"},
    render:renderSpiral},
  directional_coupler:{label:"Dir. Coupler",icon:"∥",color:"#0d47a1",desc:"Evanescent directional coupler",
    defaultParams:{coupling_length:30,gap:0.3,wg_width:0.7,straight_length:20},
    paramLabels:{coupling_length:"Coupling length (µm)",gap:"Gap (µm)",wg_width:"WG width (µm)",straight_length:"Straight ext. (µm)"},
    render:renderDC},
  phase_modulator:{label:"Phase Mod.",icon:"φ",color:"#bf360c",desc:"Electro-optic phase modulator with electrodes",
    defaultParams:{mod_length:200,wg_width:0.7,electrode_width:10},
    paramLabels:{mod_length:"Modulator length (µm)",wg_width:"WG width (µm)",electrode_width:"Electrode width (µm)"},
    render:renderPhaseMod},
  ssc:{label:"Spot Size Conv.",icon:"▷",color:"#0d47a1",desc:"Adiabatic taper for mode-size conversion",
    defaultParams:{taper_length:100,width_in:0.7,width_out:3.0},
    paramLabels:{taper_length:"Taper length (µm)",width_in:"Width in (µm)",width_out:"Width out (µm)"},
    render:renderSSC},
  y_junction:{label:"Y-junction",icon:"⑂",color:"#0d47a1",desc:"1×2 waveguide Y-splitter",
    defaultParams:{junction_length:30,wg_width:0.7,arm_separation:10},
    paramLabels:{junction_length:"Length (µm)",wg_width:"WG width (µm)",arm_separation:"Arm separation (µm)"},
    render:renderYjunction},
  mzi:{label:"MZI",icon:"⋈",color:"#0d47a1",desc:"Mach-Zehnder interferometer",
    defaultParams:{arm_length:200,arm_separation:20,wg_width:0.7,delta_length:0,splitter_length:30},
    paramGroups:[{label:"Optical",keys:["wg_width","arm_length","arm_separation"]},{label:"Design",keys:["delta_length","splitter_length"]}],
    paramLabels:{arm_length:"Arm length (µm)",arm_separation:"Arm sep. (µm)",wg_width:"WG width (µm)",delta_length:"ΔL (µm)",splitter_length:"Splitter length (µm)"},
    render:renderMZI},
  text_label:{label:"Text Label",icon:"A",color:"#546e7a",desc:"GDS text label polygon (nazca.font)",
    defaultParams:{text:"CHIP_V1",text_height:50,layer:"SiNWG"},
    paramLabels:{text:"Text",text_height:"Height (µm)",layer:"Layer"},
    render:renderTextLabel},
  // ── Geometry Shapes (nazca.geometries) ──
  geo_rectangle:{label:"Rectangle",icon:"▭",color:"#5c6bc0",
    defaultParams:{length:50,height:30,layer:"SiNWG"},
    paramLabels:{length:"Length (µm)",height:"Height (µm)",layer:"Layer"},
    render:renderRectangle},
  geo_circle:{label:"Circle",icon:"●",color:"#5c6bc0",
    defaultParams:{radius:25,layer:"SiNWG"},
    paramLabels:{radius:"Radius (µm)",layer:"Layer"},
    render:renderCircle},
  geo_ring:{label:"Ring",icon:"◯",color:"#5c6bc0",
    defaultParams:{radius:25,width:3,layer:"SiNWG"},
    paramLabels:{radius:"Radius (µm)",width:"Width (µm)",layer:"Layer"},
    render:renderGeoRing},
  geo_arc:{label:"Arc",icon:"◠",color:"#5c6bc0",
    defaultParams:{radius:25,width:3,angle:180,layer:"SiNWG"},
    paramLabels:{radius:"Radius (µm)",width:"Width (µm)",angle:"Angle (°)",layer:"Layer"},
    render:renderArc},
  geo_taper:{label:"Taper",icon:"◁",color:"#5c6bc0",
    defaultParams:{length:50,width1:2,width2:10,layer:"SiNWG"},
    paramLabels:{length:"Length (µm)",width1:"Width start (µm)",width2:"Width end (µm)",layer:"Layer"},
    render:renderTaper},
  geo_trapezoid:{label:"Trapezoid",icon:"⏢",color:"#5c6bc0",
    defaultParams:{length:50,height:30,angle1:70,angle2:70,layer:"SiNWG"},
    paramLabels:{length:"Length (µm)",height:"Height (µm)",angle1:"Angle 1 (°)",angle2:"Angle 2 (°)",layer:"Layer"},
    render:renderTrapezoid},
  geo_parallelogram:{label:"Parallelogram",icon:"▱",color:"#5c6bc0",
    defaultParams:{length:50,height:30,angle:60,layer:"SiNWG"},
    paramLabels:{length:"Length (µm)",height:"Height (µm)",angle:"Angle (°)",layer:"Layer"},
    render:renderParallelogram},
  geo_rhombus:{label:"Rhombus",icon:"◆",color:"#5c6bc0",
    defaultParams:{length:40,angle:60,layer:"SiNWG"},
    paramLabels:{length:"Side length (µm)",angle:"Angle (°)",layer:"Layer"},
    render:renderRhombus},
  geo_rounded_rect:{label:"Rounded Rect",icon:"▢",color:"#5c6bc0",
    defaultParams:{length:50,height:30,shrink:0.2,layer:"SiNWG"},
    paramLabels:{length:"Length (µm)",height:"Height (µm)",shrink:"Corner ratio",layer:"Layer"},
    render:renderRoundedRect},
  geo_frame:{label:"Frame",icon:"⬜",color:"#5c6bc0",
    defaultParams:{frame_width:5,frame_length:50,frame_height:40,layer:"SiNWG"},
    paramLabels:{frame_width:"Frame width (µm)",frame_length:"Length (µm)",frame_height:"Height (µm)",layer:"Layer"},
    render:renderFrame},
  geo_pie:{label:"Pie/Sector",icon:"◔",color:"#5c6bc0",
    defaultParams:{radius:25,angle:270,layer:"SiNWG"},
    paramLabels:{radius:"Radius (µm)",angle:"Angle (°)",layer:"Layer"},
    render:renderPie},
  geo_tetragon:{label:"Tetragon",icon:"⬠",color:"#5c6bc0",
    defaultParams:{length:40,height:30,dx:20,x_top:5,layer:"SiNWG"},
    paramLabels:{length:"Base length (µm)",height:"Height (µm)",dx:"Top width (µm)",x_top:"Top offset (µm)",layer:"Layer"},
    render:renderTetragon},
  // ── Photonic Building Blocks ──
  mmi_splitter:{label:"MMI Splitter",icon:"⫿",color:"#0d47a1",
    defaultParams:{mmi_length:50,mmi_width:12,wg_width:0.7,num_inputs:1,num_outputs:2},
    paramLabels:{mmi_length:"MMI length (µm)",mmi_width:"MMI width (µm)",wg_width:"WG width (µm)",num_inputs:"Num inputs",num_outputs:"Num outputs"},
    render:renderMMI},
  directional_coupler:{label:"Dir. Coupler",icon:"⫽",color:"#0d47a1",
    defaultParams:{coupling_length:30,gap:0.3,wg_width:0.7,straight_length:20},
    paramLabels:{coupling_length:"Coupling length (µm)",gap:"Gap (µm)",wg_width:"WG width (µm)",straight_length:"Straight ext. (µm)"},
    render:renderDC},
  phase_modulator:{label:"Phase Modulator",icon:"φ",color:"#bf360c",
    defaultParams:{mod_length:200,wg_width:0.7,electrode_width:10},
    paramLabels:{mod_length:"Modulator length (µm)",wg_width:"WG width (µm)",electrode_width:"Electrode width (µm)"},
    render:renderPhaseMod},
  ssc:{label:"Spot Size Conv.",icon:"◁▷",color:"#0d47a1",
    defaultParams:{taper_length:100,width_in:0.7,width_out:3.0},
    paramLabels:{taper_length:"Taper length (µm)",width_in:"Width in (µm)",width_out:"Width out (µm)"},
    render:renderSSC},
  y_junction:{label:"Y-junction",icon:"⑂",color:"#0d47a1",
    defaultParams:{junction_length:30,wg_width:0.7,arm_separation:10},
    paramLabels:{junction_length:"Length (µm)",wg_width:"WG width (µm)",arm_separation:"Arm separation (µm)"},
    render:renderYjunction},
  mzi:{label:"MZI",icon:"⋈",color:"#0d47a1",
    defaultParams:{arm_length:200,arm_separation:20,wg_width:0.7,delta_length:0,splitter_length:30},
    paramGroups:[{label:"Optical",keys:["wg_width","arm_length","arm_separation"]},{label:"Design",keys:["delta_length","splitter_length"]}],
    paramLabels:{arm_length:"Arm length (µm)",arm_separation:"Arm sep. (µm)",wg_width:"WG width (µm)",delta_length:"ΔL (µm)",splitter_length:"Splitter length (µm)"},
    render:renderMZI},
  // ── New Bends & Curves ──
  euler_bend:{label:"Euler Bend",icon:"⤾",color:"#2e7d32",desc:"Clothoid bend with zero curvature at ends",
    defaultParams:{angle:90,radius:100,wg_width:0.7},
    paramLabels:{angle:"Angle (°)",radius:"Radius (µm)",wg_width:"WG width (µm)"},
    render:renderEulerBend},
  sine_bend:{label:"Sine Bend",icon:"∿",color:"#8e24aa",desc:"S-curve with zero curvature at both ends",
    defaultParams:{distance:100,offset:50,wg_width:0.7},
    paramLabels:{distance:"Distance (µm)",offset:"Offset (µm)",wg_width:"WG width (µm)"},
    render:renderSineBend},
  tapered_bend:{label:"Tapered Bend",icon:"⤷",color:"#f57c00",desc:"Bend with width taper along curve",
    defaultParams:{angle:90,radius:100,width1:0.5,width2:2.0},
    paramLabels:{angle:"Angle (°)",radius:"Radius (µm)",width1:"Width start (µm)",width2:"Width end (µm)"},
    render:renderTaperedBend},
  // ── Gratings & PhC ──
  dbr_grating:{label:"DBR Grating",icon:"⫾",color:"#0277bd",desc:"Distributed Bragg Reflector for wavelength filtering",
    defaultParams:{period:0.32,num_periods:100,wg_width:0.7,duty_cycle:0.5,delta_w:0.1},
    paramGroups:[{label:"Grating",keys:["period","num_periods","duty_cycle"]},{label:"Waveguide",keys:["wg_width","delta_w"]}],
    paramLabels:{period:"Period (µm)",num_periods:"Num periods",wg_width:"WG width (µm)",duty_cycle:"Duty cycle",delta_w:"Width modulation (µm)"},
    render:renderDBR},
  photonic_crystal:{label:"Photonic Crystal",icon:"⬡",color:"#303f9f",desc:"Periodic hole array for bandgap engineering",
    defaultParams:{rows:5,cols:10,hole_radius:0.15,pitch_x:0.45,pitch_y:0.45,lattice:"square",layer:"SiNWG"},
    paramGroups:[{label:"Array",keys:["rows","cols","lattice"]},{label:"Geometry",keys:["hole_radius","pitch_x","pitch_y"]},{label:"Layer",keys:["layer"]}],
    paramLabels:{rows:"Rows",cols:"Columns",hole_radius:"Hole radius (µm)",pitch_x:"X pitch (µm)",pitch_y:"Y pitch (µm)",lattice:"Lattice type",layer:"Layer"},
    render:renderPhotonicCrystal},
  // ── Arrays & Patterns ──
  square_array:{label:"Square Array",icon:"⊞",color:"#00897b",desc:"Grid of rectangles in square lattice",
    defaultParams:{rows:5,cols:5,element_width:10,element_height:10,pitch_x:20,pitch_y:20,layer:"SiNWG"},
    paramGroups:[{label:"Array",keys:["rows","cols"]},{label:"Element",keys:["element_width","element_height"]},{label:"Pitch",keys:["pitch_x","pitch_y"]},{label:"Layer",keys:["layer"]}],
    paramLabels:{rows:"Rows",cols:"Columns",element_width:"Element W (µm)",element_height:"Element H (µm)",pitch_x:"X pitch (µm)",pitch_y:"Y pitch (µm)",layer:"Layer"},
    render:renderSquareArray},
  circular_array:{label:"Circular Array",icon:"⊛",color:"#d81b60",desc:"Elements arranged on concentric circles",
    defaultParams:{num_elements:8,arc_spacing:0,num_layers:1,radius:100,layer_spacing:20,angular_spacing:0,start_angle:0,end_angle:360,element_width:10,element_height:10,element_shape:"rectangle",rotate_elements:true,layer:"SiNWG"},
    paramGroups:[{label:"Spacing Mode",keys:["num_elements","arc_spacing"]},{label:"Rings",keys:["num_layers","radius","layer_spacing","angular_spacing"]},{label:"Angle Range",keys:["start_angle","end_angle"]},{label:"Element",keys:["element_width","element_height","element_shape","rotate_elements"]},{label:"Layer",keys:["layer"]}],
    paramLabels:{num_elements:"Elements per ring (if arc_spacing=0)",arc_spacing:"Arc spacing (µm, 0=use count)",num_layers:"Num rings",radius:"Inner radius (µm)",layer_spacing:"Ring spacing (µm)",angular_spacing:"Angular offset (°)",start_angle:"Start angle (°)",end_angle:"End angle (°)",element_width:"Element W (µm)",element_height:"Element H (µm)",element_shape:"Shape",rotate_elements:"Rotate to center",layer:"Layer"},
    render:renderCircularArray},
  // ── Arc Trapezoid ──
  arc_trapezoid:{label:"Arc Trapezoid",icon:"◗",color:"#5c6bc0",desc:"Curved trapezoid with controllable widths",
    defaultParams:{outer_radius:100,inner_radius:50,angle:90,outer_width:10,inner_width:5,inner_style:"arc",layer:"SiNWG"},
    paramGroups:[{label:"Radii",keys:["outer_radius","inner_radius"]},{label:"Width",keys:["outer_width","inner_width"]},{label:"Arc",keys:["angle","inner_style"]},{label:"Layer",keys:["layer"]}],
    paramLabels:{outer_radius:"Outer radius (µm)",inner_radius:"Inner radius (µm)",outer_width:"Outer width (µm)",inner_width:"Inner width (µm)",angle:"Angle (°)",inner_style:"Inner edge style",layer:"Layer"},
    render:renderArcTrapezoid},
  // ── Custom Shapes ──
  custom_polygon:{label:"Custom Polygon",icon:"⬟",color:"#7b1fa2",desc:"User-defined polygon vertices",
    defaultParams:{points:"[[0,0],[100,0],[100,50],[50,80],[0,50]]",layer:"SiNWG"},
    paramLabels:{points:"Vertices [[x,y],...]",layer:"Layer",original_name:"Cell Name",imported:"Imported"},
    render:renderCustomPolygon},
  // ── Imported GDS ──
  imported_gds:{label:"Imported GDS",icon:"📥",color:"#455a64",desc:"Imported GDS cell with all polygons",
    defaultParams:{},
    paramLabels:{original_name:"Cell Name",polygon_count:"Polygon Count",imported:"Imported"},
    render:null},  // Rendered via polygon system, not icon
  // ── Image Layer ──
  image_layer:{label:"Image Layer",icon:"🖼",color:"#607d8b",desc:"Reference image overlay for design alignment",
    defaultParams:{width:500,height:500,image_url:"",layer:"Alignment",opacity:0.5},
    paramGroups:[{label:"Size",keys:["width","height"]},{label:"Image",keys:["image_url","opacity"]},{label:"Layer",keys:["layer"]}],
    paramLabels:{width:"Width (µm)",height:"Height (µm)",image_url:"Image URL/Base64",layer:"Layer",opacity:"Opacity"},
    render:renderImageLayer},
};

// ═══ PIN POSITIONS ═══
function getPins(comp, S, polyData = null) {
  // If polyData (GDS pin data) is provided, use it instead of icon pins
  if (polyData && polyData.pins) {
    const rot = (comp.rotation || 0) * Math.PI / 180;
    
    return Object.entries(polyData.pins).map(([pinId, pinPos]) => {
      // GDS pins are in absolute GDS coordinates
      // We need to convert to relative offsets from the anchor (a0) position
      
      // Find anchor position (a0 is the connection point)
      let anchorX = 0, anchorY = 0;
      if (polyData.pins.a0) {
        anchorX = polyData.pins.a0.x;
        anchorY = polyData.pins.a0.y;
      } else if (polyData.pins.opt_in) {
        anchorX = polyData.pins.opt_in.x;
        anchorY = polyData.pins.opt_in.y;
      } else {
        const firstPin = Object.values(polyData.pins)[0];
        if (firstPin) {
          anchorX = firstPin.x;
          anchorY = firstPin.y;
        }
      }
      
      // Pin offset from anchor (in µm)
      // Note: GDS Y is flipped relative to screen Y
      const dx = pinPos.x - anchorX;
      const dy = -(pinPos.y - anchorY);  // Flip Y for screen coordinates
      
      // Apply component rotation
      const rdx = dx * Math.cos(rot) - dy * Math.sin(rot);
      const rdy = dx * Math.sin(rot) + dy * Math.cos(rot);
      
      // Determine layer based on pin name
      let layer = "SiN";
      if (pinId.startsWith("el_") || pinId.includes("metal") || pinId.includes("gm1") || pinId.startsWith("a1") || pinId.startsWith("b1")) {
        layer = "GM1";
      }
      
      return {
        id: pinId,
        dx: dx,
        dy: dy,
        layer: layer,
        absX: (comp.x + rdx) * S,
        absY: (comp.y + rdy) * S,
        wx: comp.x + rdx,
        wy: comp.y + rdy
      };
    });
  }
  
  // Fallback to icon-based pins
  const def = DEFS[comp.type];
  if (!def || !def.render) return [];
  const { pins } = def.render(comp.params, false, S, comp.rotation || 0);
  const rot = (comp.rotation || 0) * Math.PI / 180;
  return pins.map(pin => {
    const rdx = pin.dx * Math.cos(rot) - pin.dy * Math.sin(rot);
    const rdy = pin.dx * Math.sin(rot) + pin.dy * Math.cos(rot);
    return { ...pin, absX: (comp.x + rdx) * S, absY: (comp.y + rdy) * S, wx: comp.x + rdx, wy: comp.y + rdy };
  });
}

// ═══ MAIN APP ═══
function App(){
  // Sessions management
  const loadSessions = () => {
    try {
      const saved = localStorage.getItem('photonic_sessions');
      if (saved) {
        const data = JSON.parse(saved);
        // Restore polygon data for imported_gds components
        data.sessions = data.sessions.map(session => ({
          ...session,
          placed: session.placed.map(comp => {
            if (comp.type === "imported_gds" && comp.params?._polyKey) {
              try {
                const polyData = localStorage.getItem(comp.params._polyKey);
                if (polyData) {
                  return {
                    ...comp,
                    params: {
                      ...comp.params,
                      all_polygons: JSON.parse(polyData)
                    }
                  };
                }
              } catch (e) {
                console.warn(`Failed to restore polygons for ${comp.id}:`, e);
              }
            }
            return comp;
          })
        }));
        return data;
      }
    } catch(e) {
      console.error("Failed to load sessions:", e);
    }
    return { 
      activeId: 'default', 
      sessions: [{ id: 'default', name: 'Untitled', placed: [], connections: [] }] 
    };
  };
  
  const [sessionsData, setSessionsData] = useState(loadSessions);
  const [activeSessionId, setActiveSessionId] = useState(sessionsData.activeId);
  
  const activeSession = sessionsData.sessions.find(s => s.id === activeSessionId) || sessionsData.sessions[0];
  
  const[placed,setPlaced]=useState(activeSession.placed);
  const[connections,setConnections]=useState(activeSession.connections);
  const history=useRef([{placed:activeSession.placed,connections:activeSession.connections}]);
  const histIdx=useRef(0);
  const skipHistory=useRef(false);

  // Auto-save sessions to localStorage
  // For imported_gds components, store polygon data separately to avoid localStorage limits
  useEffect(() => {
    // Prepare placed data for storage - extract large polygon data
    const placedForStorage = placed.map(comp => {
      if (comp.type === "imported_gds" && comp.params?.all_polygons) {
        // Store polygons separately with a unique key
        const polyKey = `poly_${comp.id}`;
        try {
          localStorage.setItem(polyKey, JSON.stringify(comp.params.all_polygons));
        } catch (e) {
          console.warn(`Failed to save polygons for ${comp.id}:`, e);
        }
        // Return component without the large polygon array, but with a reference
        return {
          ...comp,
          params: {
            ...comp.params,
            all_polygons: null,  // Don't store in session
            _polyKey: polyKey   // Reference to stored polygons
          }
        };
      }
      return comp;
    });
    
    const updatedSessions = sessionsData.sessions.map(s => 
      s.id === activeSessionId ? { ...s, placed: placedForStorage, connections } : s
    );
    const newData = { activeId: activeSessionId, sessions: updatedSessions };
    setSessionsData(newData);
    try {
      localStorage.setItem('photonic_sessions', JSON.stringify(newData));
    } catch (e) {
      console.error("Failed to save session:", e);
    }
  }, [placed, connections, activeSessionId]);

  // Switch session
  const switchSession = (id) => {
    // Save current first
    const updatedSessions = sessionsData.sessions.map(s => 
      s.id === activeSessionId ? { ...s, placed, connections } : s
    );
    const target = updatedSessions.find(s => s.id === id);
    if (target) {
      // Restore polygon data for imported_gds components
      const restoredPlaced = target.placed.map(comp => {
        if (comp.type === "imported_gds" && comp.params?._polyKey && !comp.params?.all_polygons) {
          try {
            const polyData = localStorage.getItem(comp.params._polyKey);
            if (polyData) {
              return {
                ...comp,
                params: {
                  ...comp.params,
                  all_polygons: JSON.parse(polyData)
                }
              };
            }
          } catch (e) {
            console.warn(`Failed to restore polygons for ${comp.id}:`, e);
          }
        }
        return comp;
      });
      setPlaced(restoredPlaced);
      setConnections(target.connections);
      setActiveSessionId(id);
      history.current = [{placed: restoredPlaced, connections: target.connections}];
      histIdx.current = 0;
    }
  };

  // New session - show modal
  const newSession = () => {
    setModalState({type:'new', value:`Design ${sessionsData.sessions.length + 1}`});
  };
  
  // Actually create the new session (called from modal)
  const doNewSession = (name) => {
    if (!name) return;
    const id = `session_${Date.now()}`;
    const newSess = { id, name, placed: [], connections: [] };
    const updatedSessions = sessionsData.sessions.map(s => 
      s.id === activeSessionId ? { ...s, placed, connections } : s
    );
    setSessionsData({ activeId: id, sessions: [...updatedSessions, newSess] });
    setPlaced([]);
    setConnections([]);
    setActiveSessionId(id);
    history.current = [{placed: [], connections: []}];
    histIdx.current = 0;
    setModalState(null);
  };

  // Rename session - show modal
  const renameSession = (id) => {
    const sess = sessionsData.sessions.find(s => s.id === id);
    if (!sess) return;
    setModalState({type:'rename', id, value:sess.name});
  };
  
  // Actually rename the session (called from modal)
  const doRenameSession = (id, name) => {
    if (!name) return;
    const updatedSessions = sessionsData.sessions.map(s => 
      s.id === id ? { ...s, name } : s
    );
    setSessionsData({ ...sessionsData, sessions: updatedSessions });
    setModalState(null);
  };

  // Delete session - show modal
  const deleteSession = (id) => {
    if (sessionsData.sessions.length <= 1) { 
      setExportMsg("✗ Cannot delete the last session");
      setTimeout(()=>setExportMsg(""),3000);
      return; 
    }
    setModalState({type:'delete', id});
  };
  
  // Actually delete the session (called from modal)
  const doDeleteSession = (id) => {
    const remaining = sessionsData.sessions.filter(s => s.id !== id);
    const newActiveId = id === activeSessionId ? remaining[0].id : activeSessionId;
    if (id === activeSessionId) {
      const target = remaining[0];
      setPlaced(target.placed);
      setConnections(target.connections);
    }
    setSessionsData({ activeId: newActiveId, sessions: remaining });
    setActiveSessionId(newActiveId);
    setModalState(null);
  };

  // Save state to history (called after meaningful changes, not during drag)
  const pushHistory=(p,c)=>{
    if(skipHistory.current)return;
    const h=history.current;
    // Trim future if we're not at the end
    history.current=h.slice(0,histIdx.current+1);
    history.current.push({placed:JSON.parse(JSON.stringify(p)),connections:JSON.parse(JSON.stringify(c))});
    if(history.current.length>50)history.current.shift(); // cap at 50
    histIdx.current=history.current.length-1;
  };
  const undo=()=>{
    if(histIdx.current<=0)return;
    histIdx.current--;
    const s=history.current[histIdx.current];
    skipHistory.current=true;
    setPlaced(s.placed);setConnections(s.connections);
    skipHistory.current=false;
  };
  const redo=()=>{
    if(histIdx.current>=history.current.length-1)return;
    histIdx.current++;
    const s=history.current[histIdx.current];
    skipHistory.current=true;
    setPlaced(s.placed);setConnections(s.connections);
    skipHistory.current=false;
  };

  // Wrap setPlaced/setConnections to auto-save history on non-drag changes
  const setPlacedH=(fn)=>{setPlaced(prev=>{const next=typeof fn==='function'?fn(prev):fn;return next})};
  const setConnsH=(fn)=>{setConnections(prev=>{const next=typeof fn==='function'?fn(prev):fn;return next})};

  // Save history when placed/connections change (debounced, skip during drag)
  const saveTimer=useRef(null);
  useEffect(()=>{
    if(skipHistory.current||dragging)return;
    clearTimeout(saveTimer.current);
    saveTimer.current=setTimeout(()=>pushHistory(placed,connections),300);
  },[placed,connections]);
  const[selected,setSelected]=useState(null); // primary selected ID
  const[multiSel,setMultiSel]=useState([]); // multi-selection array (for alignment)
  const[selConn,setSelConn]=useState(null);
  const[dragging,setDragging]=useState(null);
  const[showCode,setShowCode]=useState(false);
  const[showLegend,setShowLegend]=useState(true); // Layer legend visibility
  const[hiddenLayers, setHiddenLayers]=useState(new Set()); // Set of layer numbers to hide
  const[code,setCode]=useState("# Add components.");
  
  // Pin alignment offset values (in µm)
  const[pinOffsetX, setPinOffsetX]=useState(0);
  const[pinOffsetY, setPinOffsetY]=useState(0);
  
  // Custom Building Blocks - saved components with their parameters
  const[customBlocks,setCustomBlocks]=useState(()=>{
    try {
      const saved = localStorage.getItem('photonic_custom_blocks');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  
  // Save custom blocks to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('photonic_custom_blocks', JSON.stringify(customBlocks));
  }, [customBlocks]);
  
  // Layer highlight state
  const[highlightLayer, setHighlightLayer] = useState(null); // layer number to highlight
  const[layerColors, setLayerColors] = useState({...DEFAULT_LAYER_COLORS});
  
  // Save Building Block modal state
  const[saveBBModal, setSaveBBModal] = useState(null); // {comps: [], defaultName: ""}
  const[saveBBName, setSaveBBName] = useState("");
  
  // Edit Building Block modal state (for layer reassignment)
  const[editBBModal, setEditBBModal] = useState(null); // block object being edited
  
  // Update global POLY_LAYER_COLORS when layerColors changes
  useEffect(() => {
    POLY_LAYER_COLORS = layerColors;
  }, [layerColors]);
  
  // Open save building block modal
  const openSaveBBModal = (comps) => {
    const compArray = Array.isArray(comps) ? comps : [comps];
    if (compArray.length === 0) return;
    
    let defaultName;
    if (compArray.length === 1) {
      const def = DEFS[compArray[0].type];
      defaultName = def ? `${def.label} Custom` : "Custom Block";
    } else {
      defaultName = `Group (${compArray.length} components)`;
    }
    
    setSaveBBName(defaultName);
    setSaveBBModal({ comps: compArray, defaultName });
  };
  
  // Confirm save building block
  const confirmSaveBB = () => {
    if (!saveBBModal || !saveBBName.trim()) return;
    
    const compArray = saveBBModal.comps;
    
    if (compArray.length === 1) {
      // Single component
      const comp = compArray[0];
      const def = DEFS[comp.type];
      
      const newBlock = {
        id: `custom_${Date.now()}`,
        name: saveBBName.trim(),
        baseType: comp.type,
        params: { ...comp.params },
        icon: def?.icon || "📦",
        color: def?.color || "#9c27b0",
        createdAt: new Date().toISOString()
      };
      
      setCustomBlocks(prev => [...prev, newBlock]);
    } else {
      // Multi-component group
      const cx = compArray.reduce((s, c) => s + c.x, 0) / compArray.length;
      const cy = compArray.reduce((s, c) => s + c.y, 0) / compArray.length;
      
      const newBlock = {
        id: `custom_${Date.now()}`,
        name: saveBBName.trim(),
        isGroup: true,
        components: compArray.map(comp => ({
          type: comp.type,
          params: { ...comp.params },
          relX: comp.x - cx,
          relY: comp.y - cy,
          rotation: comp.rotation || 0
        })),
        icon: "📦",
        color: "#9c27b0",
        createdAt: new Date().toISOString()
      };
      
      setCustomBlocks(prev => [...prev, newBlock]);
    }
    
    setSaveBBModal(null);
    setSaveBBName("");
    setExportMsg(`✓ Saved "${saveBBName.trim()}" to My Building Blocks`);
    setTimeout(() => setExportMsg(""), 3000);
  };
  
  // Legacy function - now opens modal
  const saveAsBuildingBlock = (comps) => {
    openSaveBBModal(comps);
  };
  
  // Delete a custom building block
  
  // Delete a custom building block
  const deleteCustomBlock = (blockId) => {
    if (window.confirm('Delete this building block?')) {
      setCustomBlocks(prev => prev.filter(b => b.id !== blockId));
    }
  };
  
  // Modal state for session dialogs (replaces browser prompt/confirm)
  const[modalState,setModalState]=useState(null); // {type:'new'|'rename'|'delete', id?, value?}
  const[sessionDropdown,setSessionDropdown]=useState(false); // show session list dropdown
  const modalInputRef=useRef(null);
  
  // Load UI preferences from localStorage FIRST
  const loadUIPrefs=()=>{
    try {
      const saved=localStorage.getItem('photonic_ui_prefs');
      if(saved) return JSON.parse(saved);
    } catch(e){}
    // Default: all groups COLLAPSED
    return {
      openGroups:{"waveguides":false,"modulators":false,"resonators":false,"pads":false,"shapes":false,"labels":false,"bends":false,"gratings":false,"other":false},
      darkMode:false,
      gridSnap:true,
      gridSize:10,
      zoom:1.0,
      pan:{x:400,y:300}
    };
  };
  const uiPrefs=useRef(loadUIPrefs());
  
  const[zoom,setZoom]=useState(uiPrefs.current.zoom||1.0);
  const[pan,setPan]=useState(uiPrefs.current.pan||{x:400,y:300});
  const[isPanning,setIsPanning]=useState(false);
  const[backendOk,setBackendOk]=useState(null);
  const[nazcaOk,setNazcaOk]=useState(false);
  const[exporting,setExporting]=useState(false);
  const[importing,setImporting]=useState(false);
  const[exportMsg,setExportMsg]=useState("");
  const[previewImg,setPreviewImg]=useState(null); // base64 PNG from matplotlib
  const[previewing,setPreviewing]=useState(false);
  const[drcResults,setDrcResults]=useState(null); // {ok, errors, warnings, summary}
  const[drcRunning,setDrcRunning]=useState(false);
  const[showDrcPanel,setShowDrcPanel]=useState(false);
  const[showPdkManager,setShowPdkManager]=useState(false); // PDK Manager modal
  const[pdkList,setPdkList]=useState([]);
  const[activePdk,setActivePdk]=useState("ihp_sin");
  const[pdkData,setPdkData]=useState(null);
  const[editingPdk,setEditingPdk]=useState(null); // PDK being edited
  const[gridSnap,setGridSnap]=useState(uiPrefs.current.gridSnap!==false);
  const[gridSize,setGridSize]=useState(uiPrefs.current.gridSize||10);
  const[autoGrid,setAutoGrid]=useState(uiPrefs.current.autoGrid!==false); // auto-scale grid with zoom
  const[pendingPin,setPendingPin]=useState(null);
  const[pendingPin2,setPendingPin2]=useState(null); // Second pin for pin align mode
  const[connLayer,setConnLayer]=useState("SiN");
  const[routeType,setRouteType]=useState("auto");
  const[alignMode,setAlignMode]=useState(false);
  const[pinAlignMode,setPinAlignMode]=useState(false); // Align by pins mode (no connection, just align)
  const[rulerMode,setRulerMode]=useState(false); // Ruler tool (replaces measure)
  const[rulerMarkers,setRulerMarkers]=useState([]); // [{id, x, y, type:'point'|'measure', x2?, y2?}]
  const[rulerDragging,setRulerDragging]=useState(null); // {startX, startY} while dragging to measure
  const[openGroups,setOpenGroups]=useState(uiPrefs.current.openGroups||{"waveguides":false,"modulators":false,"resonators":false,"pads":false,"shapes":false,"labels":false}); // collapsible groups - start collapsed
  const[mousePos,setMousePos]=useState({x:0,y:0});
  const[darkMode,setDarkMode]=useState(uiPrefs.current.darkMode||false);
  const gdsInputRef=useRef(null); // Hidden file input for GDS import
  
  // ═══ POLYGON RENDERING MODE ═══
  const[useRealPolygons,setUseRealPolygons]=useState(true); // Always use polygon mode
  const[componentPolygons,setComponentPolygons]=useState({}); // {compId: {polygons, bbox}}
  const[connectionPolygons,setConnectionPolygons]=useState({}); // {connId: {polygons, bbox}}
  const[polygonLoadingIds,setPolygonLoadingIds]=useState(new Set());
  
  // Connection polygon cache
  const connectionPolyCache = useRef(new Map());
  
  // Fetch polygons for a connection/route
  const fetchConnectionPolygons = useCallback(async (conn, p1World, p2World) => {
    if (!backendOk || !nazcaOk) {
      console.log("[Conn] Backend or nazca not ready");
      return null;
    }
    
    const cacheKey = `${p1World.x.toFixed(2)}_${p1World.y.toFixed(2)}_${p2World.x.toFixed(2)}_${p2World.y.toFixed(2)}_${conn.routeType}_${conn.layer}_${conn.width}_${conn.radius}`;
    
    if (connectionPolyCache.current.has(cacheKey)) {
      return connectionPolyCache.current.get(cacheKey);
    }
    
    try {
      console.log(`[Conn] Fetching polygons: ${conn.id}`, {x1: p1World.x, y1: p1World.y, x2: p2World.x, y2: p2World.y});
      const resp = await fetch(`${API}/connection_polygons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: conn.id,
          x1: p1World.x,
          y1: p1World.y,
          x2: p2World.x,
          y2: p2World.y,
          routeType: conn.routeType || "sbend_p2p",
          layer: conn.layer || "SiN",
          width: conn.width || (conn.layer === "GM1" ? 3 : 0.7),
          width2: conn.width2,
          radius: conn.radius || 100
        })
      });
      
      if (resp.ok) {
        const data = await resp.json();
        console.log(`[Conn] Got ${data.count || data.polygons?.length || 0} polygons for ${conn.id}`);
        connectionPolyCache.current.set(cacheKey, data);
        return data;
      } else {
        console.error(`[Conn] Failed to fetch: ${resp.status} ${resp.statusText}`);
      }
    } catch (e) {
      console.error("[Conn] Failed to fetch connection polygons:", e);
    }
    return null;
  }, [backendOk, nazcaOk]);
  
  // Fetch polygons for a component
  const fetchComponentPolygons = useCallback(async (comp) => {
    if (!backendOk || !nazcaOk) return null;
    
    const cacheKey = `${comp.type}_${JSON.stringify(comp.params)}`;
    
    // Check cache first
    if (polygonCache.has(cacheKey)) {
      return polygonCache.get(cacheKey);
    }
    
    try {
      const response = await fetch(`${API}/component_polygons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          id: comp.id,
          type: comp.type, 
          params: comp.params 
        })
      });
      
      if (!response.ok) return null;
      
      const data = await response.json();
      if (data.polygons && data.polygons.length > 0) {
        polygonCache.set(cacheKey, data);
        return data;
      }
      return null;
    } catch (e) {
      console.error("Failed to fetch polygons:", e);
      return null;
    }
  }, [backendOk, nazcaOk]);
  
  // Load polygons for all components (always - no icon mode)
  useEffect(() => {
    if (!backendOk || !nazcaOk) return;
    
    const loadPolygons = async () => {
      const newPolygons = { ...componentPolygons };
      const loadingIds = new Set();
      
      for (const comp of placed) {
        // For imported GDS, use the embedded polygon data directly
        if (comp.type === "imported_gds" && comp.params?.all_polygons) {
          if (!componentPolygons[comp.id]) {
            const polys = comp.params.all_polygons;
            const bbox = comp.params.bbox || {x_min:0,y_min:0,x_max:100,y_max:0};
            
            // Find narrow waveguides for pin placement
            const narrowThreshold = 2.0;
            const narrowWgs = [];
            polys.forEach(poly => {
              if(poly.layer !== 119) return;
              let pMinX=Infinity, pMaxX=-Infinity, pMinY=Infinity, pMaxY=-Infinity;
              poly.points.forEach(([x,y]) => {
                pMinX = Math.min(pMinX, x);
                pMaxX = Math.max(pMaxX, x);
                pMinY = Math.min(pMinY, y);
                pMaxY = Math.max(pMaxY, y);
              });
              if((pMaxY - pMinY) < narrowThreshold) {
                narrowWgs.push({minX: pMinX, maxX: pMaxX, minY: pMinY, maxY: pMaxY});
              }
            });
            
            let leftPinX = bbox.x_min || 0, leftPinY = ((bbox.y_min || 0) + (bbox.y_max || 0)) / 2;
            let rightPinX = bbox.x_max || 100, rightPinY = leftPinY;
            
            if(narrowWgs.length > 0) {
              const leftmost = narrowWgs.reduce((a,b) => a.minX < b.minX ? a : b);
              const rightmost = narrowWgs.reduce((a,b) => a.maxX > b.maxX ? a : b);
              leftPinX = leftmost.minX;
              leftPinY = (leftmost.minY + leftmost.maxY) / 2;
              rightPinX = rightmost.maxX;
              rightPinY = (rightmost.minY + rightmost.maxY) / 2;
            }
            
            newPolygons[comp.id] = {
              polygons: polys,
              bbox: bbox,
              pins: {a0: {x: 0, y: 0}, b0: {x: rightPinX - leftPinX, y: rightPinY - leftPinY}},
              cacheKey: `imported_${comp.id}`
            };
          }
          continue;
        }
        const cacheKey = `${comp.type}_${JSON.stringify(comp.params)}`;
        
        // Skip if already loaded or loading
        if (componentPolygons[comp.id] && 
            componentPolygons[comp.id].cacheKey === cacheKey) continue;
        
        loadingIds.add(comp.id);
      }
      
      if (loadingIds.size === 0) return;
      setPolygonLoadingIds(loadingIds);
      
      for (const comp of placed) {
        const cacheKey = `${comp.type}_${JSON.stringify(comp.params)}`;
        if (componentPolygons[comp.id]?.cacheKey === cacheKey) continue;
        
        const data = await fetchComponentPolygons(comp);
        if (data) {
          newPolygons[comp.id] = { ...data, cacheKey };
        }
      }
      
      setComponentPolygons(newPolygons);
      setPolygonLoadingIds(new Set());
    };
    
    loadPolygons();
  }, [placed, backendOk, nazcaOk]);
  
  // Connection polygon loading disabled - using SVG path approximations instead
  // The actual GDS export still uses real nazca routing
  
  // Save UI preferences to localStorage whenever they change
  useEffect(()=>{
    const prefs={openGroups,darkMode,gridSnap,gridSize,autoGrid,zoom,pan,useRealPolygons};
    localStorage.setItem('photonic_ui_prefs',JSON.stringify(prefs));
  },[openGroups,darkMode,gridSnap,gridSize,autoGrid,zoom,pan,useRealPolygons]);
  const panStart=useRef(null);
  const canvasRef=useRef(null);
  const dragOff=useRef({x:0,y:0});
  const idCtr=useRef(0);
  const connCtr=useRef(0);
  const S=BS*zoom;
  
  // ═══ HYBRID ZOOM ═══
  // renderZoom = zoom level at which SVG polygons are rendered crisp
  // During active zoom: CSS transform bridges gap (GPU-composited, instant)
  // After 150ms idle: renderZoom catches up (crisp re-render)
  const[renderZoom,setRenderZoom]=useState(zoom);
  const renderZoomTimer=useRef(null);
  const RS=BS*renderZoom;
  const cssZoomRatio=zoom/renderZoom;
  
  useEffect(()=>{
    clearTimeout(renderZoomTimer.current);
    renderZoomTimer.current=setTimeout(()=>setRenderZoom(zoom),150);
    return()=>clearTimeout(renderZoomTimer.current);
  },[zoom]);
  
  // Auto-calculate grid size based on zoom level for smooth movement
  const effectiveGridSize = autoGrid ? (
    zoom >= 50 ? 0.01 :
    zoom >= 25 ? 0.02 :
    zoom >= 15 ? 0.05 :
    zoom >= 8 ? 0.1 :
    zoom >= 4 ? 0.2 :
    zoom >= 2 ? 0.5 :
    zoom >= 1 ? 1 :
    zoom >= 0.5 ? 2 :
    zoom >= 0.25 ? 5 :
    zoom >= 0.1 ? 10 :
    20
  ) : gridSize;
  
  // Smooth snap function - rounds to nearest grid unit
  const snap = v => {
    const g = effectiveGridSize;
    // Use higher precision rounding for sub-micron grids
    if (g < 1) {
      const decimals = g <= 0.01 ? 2 : g <= 0.1 ? 1 : 1;
      return Math.round(v / g) * g;
    }
    return Math.round(v / g) * g;
  };

  useEffect(()=>{fetch(`${API}/status`).then(r=>r.json()).then(d=>{setBackendOk(true);setNazcaOk(d.nazca_available)}).catch(()=>setBackendOk(false))},[]);
  useEffect(()=>{if(!backendOk||!placed.length){setCode("# Add components.");return;}
    fetch(`${API}/generate_code`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({components:placed,connections})}).then(r=>r.json()).then(d=>setCode(d.code)).catch(()=>{});},[placed,connections,backendOk]);
  // Clipboard for copy/paste
  const clipboard=useRef(null);

  useEffect(()=>{const h=e=>{
    const ctrl=e.ctrlKey||e.metaKey;
    if(e.key==="Escape"){setPendingPin(null);setPendingPin2(null);setSelected(null);setSelConn(null);setMultiSel([]);setAlignMode(false);setPinAlignMode(false);setRulerMode(false);setRulerDragging(null)}

    // Undo / Redo
    if(ctrl&&e.key==="z"&&!e.shiftKey){e.preventDefault();undo()}
    if(ctrl&&(e.key==="y"||(e.key==="z"&&e.shiftKey))){e.preventDefault();redo()}
    
    // Save (Ctrl+S) - export JSON file
    if(ctrl&&e.key==="s"){
      e.preventDefault();
      const data={
        version:1,
        sessionName:activeSession?.name||"Untitled",
        placed,
        connections,
        exportedAt:new Date().toISOString()
      };
      const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;
      a.download=`${activeSession?.name||"photonic_design"}_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExportMsg("✓ Design saved to JSON file");
      setTimeout(()=>setExportMsg(""),3000);
    }
    
    // Open (Ctrl+O) - import JSON file
    if(ctrl&&e.key==="o"){
      e.preventDefault();
      const input=document.createElement("input");
      input.type="file";
      input.accept=".json";
      input.onchange=ev=>{
        const file=ev.target.files?.[0];
        if(!file)return;
        const reader=new FileReader();
        reader.onload=re=>{
          try{
            const data=JSON.parse(re.target.result);
            if(data.placed&&Array.isArray(data.placed)){
              setPlaced(data.placed);
              setConnections(data.connections||[]);
              setSelected(null);setMultiSel([]);setSelConn(null);
              history.current=[{placed:data.placed,connections:data.connections||[]}];
              histIdx.current=0;
              setExportMsg(`✓ Loaded ${data.sessionName||"design"} (${data.placed.length} components)`);
              setTimeout(()=>setExportMsg(""),4000);
            }else{
              setExportMsg("✗ Invalid design file format");
              setTimeout(()=>setExportMsg(""),3000);
            }
          }catch(err){
            setExportMsg("✗ Failed to parse JSON file");
            setTimeout(()=>setExportMsg(""),3000);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    }

    // Select all
    if(ctrl&&e.key==="a"){e.preventDefault();setMultiSel(placed.map(c=>c.id));if(placed.length)setSelected(placed[0].id)}

    // Clear ruler markers (Ctrl+K)
    if(ctrl&&e.key==="k"){e.preventDefault();setRulerMarkers([]);setRulerDragging(null)}

    // Copy selected
    if(ctrl&&e.key==="c"){
      e.preventDefault();
      const ids=multiSel.length>1?multiSel:selected?[selected]:[];
      if(ids.length){clipboard.current=ids.map(id=>placed.find(c=>c.id===id)).filter(Boolean).map(c=>({...c,params:{...c.params}}))}
    }

    // Paste
    if(ctrl&&e.key==="v"){
      e.preventDefault();
      if(clipboard.current&&clipboard.current.length){
        const newIds=[];
        const idMap={};
        const copies=clipboard.current.map(c=>{
          const newId=`${c.type.replace(/_/g,"")}_${++idCtr.current}`;
          idMap[c.id]=newId;
          newIds.push(newId);
          return{...c,id:newId,x:c.x+20,y:c.y+20,params:{...c.params}};
        });
        setPlaced(p=>[...p,...copies]);
        // Also copy connections between pasted components
        const oldIds=new Set(clipboard.current.map(c=>c.id));
        const newConns=connections.filter(cn=>oldIds.has(cn.fromComp)&&oldIds.has(cn.toComp)).map(cn=>({
          ...cn,id:`cn_${++connCtr.current}`,fromComp:idMap[cn.fromComp],toComp:idMap[cn.toComp]
        }));
        if(newConns.length)setConnections(p=>[...p,...newConns]);
        setMultiSel(newIds);setSelected(newIds[0]);
      }
    }

    // Duplicate (Ctrl+D)
    if(ctrl&&e.key==="d"){
      e.preventDefault();
      const ids=multiSel.length>1?multiSel:selected?[selected]:[];
      if(ids.length){
        const newIds=[];
        const copies=ids.map(id=>{const c=placed.find(c=>c.id===id);if(!c)return null;
          const newId=`${c.type.replace(/_/g,"")}_${++idCtr.current}`;newIds.push(newId);
          return{...c,id:newId,x:c.x+20,y:c.y+20,params:{...c.params}};}).filter(Boolean);
        setPlaced(p=>[...p,...copies]);setMultiSel(newIds);setSelected(newIds[0]);
      }
    }

    // Delete selected (single or multi)
    if(e.key==="Delete"||e.key==="Backspace"){
      // Don't delete if focused on an input
      if(e.target.tagName==="INPUT"||e.target.tagName==="SELECT"||e.target.tagName==="TEXTAREA")return;
      e.preventDefault();
      const ids=multiSel.length>1?multiSel:selected?[selected]:[];
      if(ids.length){
        const idSet=new Set(ids);
        setConnections(p=>p.filter(cn=>!idSet.has(cn.fromComp)&&!idSet.has(cn.toComp)));
        setPlaced(p=>p.filter(c=>!idSet.has(c.id)));
        setSelected(null);setMultiSel([]);
      }else if(selConn){
        setConnections(p=>p.filter(cn=>cn.id!==selConn));setSelConn(null);
      }
    }
  };window.addEventListener("keydown",h);return()=>window.removeEventListener("keydown",h)});
  const onWheel=useCallback(e=>{
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    // Get cursor position relative to canvas
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    
    // Calculate world position under cursor before zoom
    const worldX = (cursorX - pan.x) / S;
    const worldY = (cursorY - pan.y) / S;
    
    // Calculate new zoom
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newZoom = Math.min(Math.max(zoom * factor, 0.05), 100);
    const newS = BS * newZoom;
    
    // Calculate new pan to keep cursor over same world position
    const newPanX = cursorX - worldX * newS;
    const newPanY = cursorY - worldY * newS;
    
    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  },[zoom, pan, S]);
  useEffect(()=>{const el=canvasRef.current;if(!el)return;el.addEventListener("wheel",onWheel,{passive:false});return()=>el.removeEventListener("wheel",onWheel)},[onWheel]);

  const onDown=e=>{
    // Middle mouse button always starts pan without clearing selection
    if(e.button===1){
      e.preventDefault();
      setIsPanning(true);
      panStart.current={x:e.clientX-pan.x,y:e.clientY-pan.y};
      return;
    }
    if(e.target===canvasRef.current||e.target.tagName==="svg"||e.target.classList?.contains("cbg")){
    // Ruler mode: click on canvas to place crosshair marker or start drag-measure
    if(rulerMode){
      const rect=canvasRef.current?.getBoundingClientRect();
      if(rect){
        const wx=(e.clientX-rect.left-pan.x)/S;
        const wy=(e.clientY-rect.top-pan.y)/S;
        setRulerDragging({startX:wx,startY:wy,currentX:wx,currentY:wy});
      }
      return;
    }
    setSelected(null);setSelConn(null);setPendingPin(null);setMultiSel([]);setIsPanning(true);panStart.current={x:e.clientX-pan.x,y:e.clientY-pan.y}}};
  const onMove=e=>{
    if(isPanning&&panStart.current)setPan({x:e.clientX-panStart.current.x,y:e.clientY-panStart.current.y});
    // Track mouse position always
    const rect=canvasRef.current?.getBoundingClientRect();
    if(rect){
      const wx=(e.clientX-rect.left-pan.x)/S;
      const wy=(e.clientY-rect.top-pan.y)/S;
      setMousePos({x:wx,y:wy});
      // Update drag measure if active
      if(rulerDragging){
        setRulerDragging(prev=>({...prev,currentX:wx,currentY:wy}));
      }
    }
    if(dragging){let nx=(e.clientX-pan.x-dragOff.current.x)/S,ny2=(e.clientY-pan.y-dragOff.current.y)/S;
      if(gridSnap){nx=snap(nx);ny2=snap(ny2)}
      
      // Optional pin-to-pin Y alignment (only when very close and holding Shift)
      // This prevents unwanted Y jumping during normal drag
      if(e.shiftKey){
        const tmp={...placed.find(c=>c.id===dragging),x:nx,y:ny2};
        const mp=getPins(tmp,S);let bestY=null,bestD=effectiveGridSize*2; // scale threshold with grid
        for(const o of placed){if(o.id===dragging)continue;for(const op of getPins(o,S))for(const m of mp){
          const dx=Math.abs(m.wx-op.wx),dy=Math.abs(m.wy-op.wy);
          if(dx<50/S&&dy<bestD&&dy>0.001){bestD=dy;bestY=op.wy-(m.wy-ny2)}}}
        if(bestY!==null)ny2=bestY;
      }
      
      setPlaced(prev=>prev.map(c=>c.id===dragging?{...c,x:nx,y:ny2}:c))}};
  const onUp=e=>{
    // Ruler mode: finish drag and create marker
    if(rulerDragging){
      const dx=Math.abs(rulerDragging.currentX-rulerDragging.startX);
      const dy=Math.abs(rulerDragging.currentY-rulerDragging.startY);
      const dist=Math.sqrt(dx*dx+dy*dy);
      
      if(dist<0.5){
        // Small movement = place crosshair point marker
        setRulerMarkers(prev=>[...prev,{
          id:`r_${Date.now()}`,
          type:'point',
          x:rulerDragging.startX,
          y:rulerDragging.startY
        }]);
      }else{
        // Large movement = place measurement marker
        setRulerMarkers(prev=>[...prev,{
          id:`r_${Date.now()}`,
          type:'measure',
          x:rulerDragging.startX,
          y:rulerDragging.startY,
          x2:rulerDragging.currentX,
          y2:rulerDragging.currentY
        }]);
      }
      setRulerDragging(null);
      return;
    }
    setIsPanning(false);setDragging(null);panStart.current=null
  };
  const startDrag=(e,id)=>{
    // Middle mouse button (scroll wheel click) should start pan, not select
    if(e.button===1){
      e.preventDefault();
      setIsPanning(true);
      panStart.current={x:e.clientX-pan.x,y:e.clientY-pan.y};
      return;
    }
    e.stopPropagation();const c=placed.find(c=>c.id===id);
    dragOff.current={x:e.clientX-pan.x-c.x*S,y:e.clientY-pan.y-c.y*S};setSelConn(null);
    // Ruler mode: clicking component centers creates point marker
    if(rulerMode){
      const bb=getBBox(c);
      setRulerMarkers(prev=>[...prev,{
        id:`r_${Date.now()}`,
        type:'point',
        x:bb.cx,
        y:bb.cy
      }]);
      return;
    }
    if(alignMode||e.shiftKey||(e.ctrlKey||e.metaKey)){
      // Multi-select: toggle in/out
      setMultiSel(prev=>{
        const has=prev.includes(id);
        const next=has?prev.filter(x=>x!==id):[...prev,id];
        if(next.length>0)setSelected(next[next.length-1]);
        else setSelected(null);
        return next;
      });
      return;
    }else{
      setDragging(id);setSelected(id);setMultiSel([id]);
    }};
  const onPinClick=(e,cid,pid,wp)=>{e.stopPropagation();
    // In ruler mode, pins become point markers
    if(rulerMode){
      setRulerMarkers(prev=>[...prev,{
        id:`r_${Date.now()}`,
        type:'point',
        x:wp.x,
        y:wp.y
      }]);
      return;
    }
    
    // PIN ALIGN MODE: Select two pins, then show alignment options
    if(pinAlignMode){
      if(!pendingPin){
        // First pin selection
        setPendingPin({compId:cid,pinId:pid,wp});
        setPendingPin2(null);
      }else if(!pendingPin2){
        // Second pin selection
        if(pendingPin.compId===cid&&pendingPin.pinId===pid){setPendingPin(null);return}
        // Store second pin - don't align yet, show options
        setPendingPin2({compId:cid,pinId:pid,wp});
      }else{
        // Third click - start over with this as first pin
        setPendingPin({compId:cid,pinId:pid,wp});
        setPendingPin2(null);
      }
      return;
    }
    
    if(!pendingPin){setPendingPin({compId:cid,pinId:pid,wp})}else{
      if(pendingPin.compId===cid&&pendingPin.pinId===pid){setPendingPin(null);return}
      
      // Add the connection (no auto-snap - use Pin Align mode for alignment)
      const newConn = {id:`cn_${++connCtr.current}`,fromComp:pendingPin.compId,fromPin:pendingPin.pinId,toComp:cid,toPin:pid,layer:connLayer,routeType};
      setConnections(prev=>[...prev, newConn]);
      setPendingPin(null);
    }};

  const addComp=type=>{const id=`${type.replace(/_/g,"")}_${++idCtr.current}`;
    setPlaced(prev=>[...prev,{id,type,x:placed.length*30,y:0,rotation:0,params:{...DEFS[type].defaultParams}}]);setSelected(id)};
  const updateParam=(k,v)=>{setPlaced(prev=>prev.map(c=>{if(c.id!==selected)return c;const old=c.params[k];const nv=(typeof old==="string"||k==="text"||k==="layer")?v:(isNaN(parseFloat(v))?v:parseFloat(v));return{...c,params:{...c.params,[k]:nv}}}))};
  const delSel=()=>{setConnections(p=>p.filter(cn=>cn.fromComp!==selected&&cn.toComp!==selected));setPlaced(p=>p.filter(c=>c.id!==selected));setSelected(null);setMultiSel([])};
  const copySel=()=>{if(!selC)return;const id=`${selC.type.replace(/_/g,"")}_${++idCtr.current}`;
    const nc={...selC,id,x:selC.x+20,y:selC.y+20,params:{...selC.params}};
    setPlaced(p=>[...p,nc]);setSelected(id);setMultiSel([id])};

  // Bounding box of a component (in µm, relative to world)
  const getBBox=(comp)=>{
    const pins=getPins(comp,BS); // use BS=2 as reference S
    const p=comp.params,t=comp.type;
    let xMin=comp.x,xMax=comp.x,yMin=comp.y,yMax=comp.y;
    // Expand by pin positions
    for(const pin of pins){xMin=Math.min(xMin,pin.wx);xMax=Math.max(xMax,pin.wx);yMin=Math.min(yMin,pin.wy);yMax=Math.max(yMax,pin.wy)}
    // Expand by component geometry
    if(t==="geo_circle"||t==="geo_ring"||t==="geo_arc"||t==="geo_pie"){
      const r=p.radius||25;xMin=Math.min(xMin,comp.x-r);xMax=Math.max(xMax,comp.x+r);yMin=Math.min(yMin,comp.y-r);yMax=Math.max(yMax,comp.y+r);
    }else if(t==="geo_rectangle"||t==="geo_rounded_rect"||t==="geo_frame"){
      const w=p.length||p.frame_length||50,h=p.height||p.frame_height||30;
      xMax=Math.max(xMax,comp.x+w);yMin=Math.min(yMin,comp.y-h/2);yMax=Math.max(yMax,comp.y+h/2);
    }else if(t==="ring_resonator"){
      const r=p.radius||60;xMax=Math.max(xMax,comp.x+2*r);yMin=Math.min(yMin,comp.y-(p.wg_width/2+p.gap+2*r));
    }
    return{xMin,xMax,yMin,yMax,cx:(xMin+xMax)/2,cy:(yMin+yMax)/2,w:xMax-xMin,h:yMax-yMin};
  };

  // Alignment functions for multi-selected components
  const alignComps=(mode, offsetX=0, offsetY=0)=>{
    if(multiSel.length<2)return;
    const bbs=multiSel.map(id=>{const c=placed.find(c=>c.id===id);return c?{id,bb:getBBox(c),comp:c}:null}).filter(Boolean);
    if(bbs.length<2)return;
    const ref=bbs[0]; // first selected = reference
    
    // Get pins for reference component
    const refPins = getPins(ref.comp, 1);
    // Find b0 pin of reference (output pin) - or rightmost pin
    const refPin = refPins.find(p => p.id === 'b0') || refPins.find(p => p.id.startsWith('b')) || refPins[refPins.length - 1];
    const refPinAbsX = ref.comp.x + (refPin?.dx || 0);
    const refPinAbsY = ref.comp.y + (refPin?.dy || 0);
    
    setPlaced(prev=>prev.map(c=>{
      const entry=bbs.find(b=>b.id===c.id);
      if(!entry||entry.id===ref.id)return c;
      const bb=entry.bb, rbb=ref.bb;
      let nx=c.x,ny=c.y;
      
      // Get pins for this component
      const thisPins = getPins(c, 1);
      // Find a0 pin (input pin) - or leftmost pin
      const thisPin = thisPins.find(p => p.id === 'a0') || thisPins.find(p => p.id.startsWith('a')) || thisPins[0];
      const thisPinAbsX = c.x + (thisPin?.dx || 0);
      const thisPinAbsY = c.y + (thisPin?.dy || 0);
      
      switch(mode){
        // Bounding box alignments
        case'center-x': nx=c.x+(rbb.cx-bb.cx); break;
        case'center-y': ny=c.y+(rbb.cy-bb.cy); break;
        case'center':   nx=c.x+(rbb.cx-bb.cx); ny=c.y+(rbb.cy-bb.cy); break;
        case'left':     nx=c.x+(rbb.xMin-bb.xMin); break;
        case'right':    nx=c.x+(rbb.xMax-bb.xMax); break;
        case'top':      ny=c.y+(rbb.yMin-bb.yMin); break;
        case'bottom':   ny=c.y+(rbb.yMax-bb.yMax); break;
        case'outer-match':
          nx=c.x+(rbb.cx-bb.cx); ny=c.y+(rbb.cy-bb.cy); break;
        
        // Pin alignments
        case'pin-match-x': // Align pins X (same X position)
          nx = c.x + (refPinAbsX - thisPinAbsX);
          break;
        case'pin-match-y': // Align pins Y (same Y position)
          ny = c.y + (refPinAbsY - thisPinAbsY);
          break;
        case'pin-match-xy': // Pins touch exactly (same X and Y)
          nx = c.x + (refPinAbsX - thisPinAbsX);
          ny = c.y + (refPinAbsY - thisPinAbsY);
          break;
        case'pin-offset-x': // Pins at X offset (Y aligned)
          nx = c.x + (refPinAbsX - thisPinAbsX) + offsetX;
          ny = c.y + (refPinAbsY - thisPinAbsY);
          break;
        case'pin-offset-y': // Pins at Y offset (X aligned)
          nx = c.x + (refPinAbsX - thisPinAbsX);
          ny = c.y + (refPinAbsY - thisPinAbsY) + offsetY;
          break;
      }
      return{...c,x:nx,y:ny};
    }));
  };
  const delConn=id=>{setConnections(p=>p.filter(cn=>cn.id!==id));setSelConn(null)};
  const exportGDS=async()=>{if(!nazcaOk)return;setExporting(true);setExportMsg("Building…");
    try{const r=await fetch(`${API}/export_gds`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({components:placed,connections,filename:"design.gds"})});
      if(!r.ok){const e=await r.json();setExportMsg(`Err: ${e.error}`)}else{const b=await r.blob();const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="photonic_design.gds";a.click();setExportMsg("✓ Done!");setTimeout(()=>setExportMsg(""),3000)}}
    catch(e){setExportMsg(`Err: ${e.message}`)}setExporting(false)};
  
  // ═══ DRC CHECK ═══
  const runDRC = async () => {
    if (!placed.length) return;
    setDrcRunning(true);
    setDrcResults(null);
    setShowDrcPanel(true);
    try {
      const r = await fetch(`${API}/drc_check`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({components: placed, connections})
      });
      const d = await r.json();
      setDrcResults(d);
      if (d.ok) {
        setExportMsg(`✓ DRC passed: ${d.summary}`);
      } else {
        setExportMsg(`⚠ DRC: ${d.summary}`);
      }
      setTimeout(() => setExportMsg(""), 4000);
    } catch (e) {
      setExportMsg(`DRC error: ${e.message}`);
      setDrcResults({ok: false, errors: [{rule: "ERROR", message: e.message}], warnings: []});
    }
    setDrcRunning(false);
  };
  
  // ═══ PDK MANAGEMENT ═══
  const loadPdkList = async () => {
    try {
      const r = await fetch(`${API}/pdk/list`);
      const d = await r.json();
      if (d.pdks) setPdkList(d.pdks);
    } catch (e) {
      console.error("Failed to load PDK list:", e);
    }
  };
  
  const loadPdk = async (pdkId) => {
    try {
      const r = await fetch(`${API}/pdk/get/${pdkId}`);
      const d = await r.json();
      if (d.pdk) {
        setPdkData(d.pdk);
        setActivePdk(pdkId);
        // Update layer colors from PDK
        if (d.pdk.layers) {
          const newColors = {};
          Object.entries(d.pdk.layers).forEach(([layerNum, layerDef]) => {
            if (layerDef.name && !layerDef.name.startsWith("_")) {
              newColors[parseInt(layerNum)] = {
                name: layerDef.name,
                color: layerDef.color || "#888888",
                opacity: layerDef.opacity || 0.7,
                pattern: layerDef.pattern || "solid"
              };
            }
          });
          setLayerColors(prev => ({...prev, ...newColors}));
        }
        setExportMsg(`✓ Loaded PDK: ${d.pdk.name}`);
        setTimeout(() => setExportMsg(""), 3000);
      }
    } catch (e) {
      setExportMsg(`PDK load error: ${e.message}`);
    }
  };
  
  const getPdkTemplate = async () => {
    try {
      const r = await fetch(`${API}/pdk/template`);
      const d = await r.json();
      if (d.template) {
        setEditingPdk(d.template);
      }
    } catch (e) {
      setExportMsg(`Error getting template: ${e.message}`);
    }
  };
  
  const savePdk = async (pdk) => {
    try {
      const pdkId = pdk.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
      const r = await fetch(`${API}/pdk/create`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({...pdk, id: pdkId})
      });
      const d = await r.json();
      if (d.ok) {
        setExportMsg(`✓ PDK saved: ${pdk.name}`);
        loadPdkList();
        setEditingPdk(null);
      } else {
        setExportMsg(`Error: ${d.error}`);
      }
    } catch (e) {
      setExportMsg(`Save error: ${e.message}`);
    }
  };
  
  const deletePdk = async (pdkId) => {
    if (!confirm(`Delete PDK "${pdkId}"?`)) return;
    try {
      const r = await fetch(`${API}/pdk/delete/${pdkId}`, {method: "DELETE"});
      const d = await r.json();
      if (d.ok) {
        setExportMsg(`✓ PDK deleted`);
        loadPdkList();
        if (activePdk === pdkId) {
          loadPdk("ihp_sin");
        }
      }
    } catch (e) {
      setExportMsg(`Delete error: ${e.message}`);
    }
  };
  
  const exportPdk = (pdkId) => {
    window.open(`${API}/pdk/export/${pdkId}`, "_blank");
  };
  
  const importPdk = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const r = await fetch(`${API}/pdk/import`, {method: "POST", body: formData});
      const d = await r.json();
      if (d.ok) {
        setExportMsg(`✓ PDK imported: ${d.pdk_id}`);
        loadPdkList();
      } else {
        setExportMsg(`Import error: ${d.error}`);
      }
    } catch (e) {
      setExportMsg(`Import error: ${e.message}`);
    }
  };
  
  // Load PDK list on mount
  useEffect(() => {
    loadPdkList();
  }, []);
  
  // Import GDS file
  const importGDS=async(file)=>{
    if(!file)return;
    setImporting(true);
    setExportMsg("Importing GDS…");
    try{
      const formData=new FormData();
      formData.append('file',file);
      const r=await fetch(`${API}/import_gds`,{method:"POST",body:formData});
      const d=await r.json();
      if(d.error){
        setExportMsg(`Import error: ${d.error}`);
      }else if(d.components&&d.components.length>0){
        // Add imported components to canvas
        const newComps=d.components.map((c,i)=>{
          // For imported GDS, store all polygons directly
          if(c.type === "imported_gds" && c.polygons && c.polygons.length > 0){
            return{
              id:`imp_${Date.now()}_${i}`,
              type:"imported_gds",
              x: c.bbox?.x_min || 0,  // Use bbox origin
              y: -(c.bbox?.y_min || 0),  // Flip Y for screen coords
              rotation: 0,
              params:{
                imported: true,
                original_name: c.original_name,
                polygon_count: c.polygons.length,
                all_polygons: c.polygons,
                width: c.width,
                height: c.height,
                bbox: c.bbox
              }
            };
          }
          
          // Fallback for other types
          let type=c.type;
          let params={...DEFS[type]?.defaultParams};
          
          if(c.polygons && c.polygons.length > 0){
            type="imported_gds";
            params={
              imported: true,
              original_name: c.original_name,
              all_polygons: c.polygons
            };
          } else if(!DEFS[type]){
            type="geo_rectangle";
            params={
              length: c.width || 100,
              height: c.height || 50,
              layer: "SiNWG",
              imported: true,
              original_name: c.original_name
            };
          } else {
            params = {...params, imported: true, original_name: c.original_name};
          }
          
          return{
            id:`${c.id}_${Date.now()}_${i}`,
            type,
            x:c.x||i*50,
            y:c.y||0,
            rotation:c.rotation||0,
            params
          };
        });
        setPlaced(prev=>[...prev,...newComps]);
        // Also store the polygon data for rendering with smart pin detection
        const newPolygonData = {};
        newComps.forEach(comp => {
          if(comp.params?.all_polygons){
            const polys = comp.params.all_polygons;
            const bbox = comp.params.bbox || {x_min:0,y_min:0,x_max:100,y_max:0};
            
            // Find NARROW waveguide polygons (< 2µm height) for pin placement
            const narrowThreshold = 2.0;
            const narrowWgs = [];
            
            polys.forEach(poly => {
              if(poly.layer !== 119) return;
              let pMinX=Infinity, pMaxX=-Infinity, pMinY=Infinity, pMaxY=-Infinity;
              poly.points.forEach(([x,y]) => {
                pMinX = Math.min(pMinX, x);
                pMaxX = Math.max(pMaxX, x);
                pMinY = Math.min(pMinY, y);
                pMaxY = Math.max(pMaxY, y);
              });
              const height = pMaxY - pMinY;
              if(height < narrowThreshold) {
                narrowWgs.push({minX: pMinX, maxX: pMaxX, minY: pMinY, maxY: pMaxY, height});
              }
            });
            
            // Find leftmost and rightmost narrow waveguides
            let leftPinX = bbox.x_min, leftPinY = (bbox.y_min + bbox.y_max) / 2;
            let rightPinX = bbox.x_max, rightPinY = leftPinY;
            
            if(narrowWgs.length > 0) {
              const leftmost = narrowWgs.reduce((a,b) => a.minX < b.minX ? a : b);
              const rightmost = narrowWgs.reduce((a,b) => a.maxX > b.maxX ? a : b);
              leftPinX = leftmost.minX;
              leftPinY = (leftmost.minY + leftmost.maxY) / 2;
              rightPinX = rightmost.maxX;
              rightPinY = (rightmost.minY + rightmost.maxY) / 2;
            }
            
            // Normalize: a0 at origin
            newPolygonData[comp.id] = {
              polygons: polys,
              bbox: bbox,
              pins: {
                a0: {x: 0, y: 0},
                b0: {x: rightPinX - leftPinX, y: rightPinY - leftPinY}
              }
            };
          }
        });
        if(Object.keys(newPolygonData).length > 0){
          setComponentPolygons(prev => ({...prev, ...newPolygonData}));
        }
        setExportMsg(`✓ ${d.message || `Imported ${newComps.length} component(s)`}`);
        setTimeout(()=>setExportMsg(""),3000);
      }else{
        setExportMsg("No components found in GDS");
      }
    }catch(e){
      setExportMsg(`Import error: ${e.message}`);
    }
    setImporting(false);
    if(gdsInputRef.current)gdsInputRef.current.value="";
  };
  
  const previewGDS=async()=>{if(!nazcaOk||!placed.length)return;setPreviewing(true);setPreviewImg(null);
    try{const r=await fetch(`${API}/preview_gds`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({components:placed,connections})});
      const d=await r.json();if(d.ok&&d.image){setPreviewImg(d.image)}else{setExportMsg(`Preview err: ${d.error||"unknown"}`)}}
    catch(e){setExportMsg(`Preview err: ${e.message}`)}setPreviewing(false)};
  const dlPy=()=>{const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([code],{type:"text/x-python"}));a.download="photonic_design.py";a.click()};

  // ── Theme (Dark/Light) ──
  const T = darkMode ? {
    bg:"#0d1117",bg2:"#161b22",bg3:"#21262d",bg4:"#30363d",border:"#30363d",
    text:"#e6edf3",textBright:"#ffffff",textDim:"#8b949e",accent:"#58a6ff",
    sin:"#58a6ff",gm1:"#f97316",success:"#3fb950",warn:"#d29922",error:"#f85149",
    canvas:"#010409",gridLine:"#21262d",inputBg:"#0d1117",
    font:"'IBM Plex Mono','SF Mono','Fira Code',monospace",sans:"'IBM Plex Sans',-apple-system,BlinkMacSystemFont,sans-serif"
  } : {
    bg:"#f8f9fa",bg2:"#ffffff",bg3:"#f0f1f3",bg4:"#e4e6e9",border:"#d0d4da",
    text:"#1a1a2e",textBright:"#0a0a1a",textDim:"#5a6070",accent:"#1565c0",
    sin:"#1565c0",gm1:"#d84315",success:"#2e7d32",warn:"#e65100",error:"#c62828",
    canvas:"#ffffff",gridLine:"#e8e8e8",inputBg:"#ffffff",
    font:"'IBM Plex Mono','SF Mono','Fira Code',monospace",sans:"'IBM Plex Sans',-apple-system,BlinkMacSystemFont,sans-serif"
  };

  // Full IHP PDK layer list
  const PDK_LAYERS = {
    GraphBot:  {num:78,  color:"#c62828", label:"GraphBot (GRB)"},
    GraphTop:  {num:79,  color:"#2e7d32", label:"GraphTop (GRT)"},
    GraphGate: {num:118, color:"#6a1b9a", label:"GraphGate"},
    GraphCont: {num:85,  color:"#795548", label:"GraphCont (GCT)"},
    GraphMetal1:{num:109,color:"#d84315", label:"GraphMetal1 (GM1)"},
    GraphMet1L:{num:110, color:"#e65100", label:"GraphMet1L"},
    SiWG:      {num:86,  color:"#0277bd", label:"SiWG"},
    SiNWG:     {num:119, color:"#1565c0", label:"SiNWG"},
    SiGrating: {num:87,  color:"#00838f", label:"SiGrating"},
    SiNGrating:{num:88,  color:"#00695c", label:"SiNGrating"},
    GraphPas:  {num:89,  color:"#f9a825", label:"GraphPas (GPS)"},
    GraphPAD:  {num:97,  color:"#4e342e", label:"GraphPAD"},
    Alignment: {num:234, color:"#546e7a", label:"Alignment"},
  };
  const selC=placed.find(c=>c.id===selected),selD=selC?DEFS[selC.type]:null,selCn=connections.find(cn=>cn.id===selConn);
  const gSz=Math.max(effectiveGridSize*S,5);
  const st=backendOk===null?{c:T.textDim,t:"connecting…"}:backendOk===false?{c:T.error,t:"offline"}:nazcaOk?{c:T.success,t:"nazca ready"}:{c:T.warn,t:"no nazca"};

  // Shared input styles
  const inp={background:T.inputBg||T.bg2,border:`1px solid ${T.border}`,color:T.text,padding:"6px 8px",borderRadius:5,fontSize:11,fontFamily:T.font,width:"100%",boxSizing:"border-box",outline:"none",fontWeight:500};
  const sel={...inp,cursor:"pointer"};
  const lbl={fontSize:10,color:T.textDim,fontFamily:T.sans,marginBottom:3,marginTop:7,fontWeight:600};
  const sec={color:T.text,fontSize:9,letterSpacing:2,textTransform:"uppercase",marginBottom:6,marginTop:14,fontFamily:T.sans,fontWeight:700};
  const hr={height:1,background:T.border,margin:"10px 0",opacity:0.5};
  const btn=(on,clr=T.accent)=>({background:on?`${clr}22`:darkMode?T.bg3:T.bg2,border:`1px solid ${on?clr:T.border}`,color:on?clr:T.textDim,padding:"6px 12px",borderRadius:5,cursor:"pointer",fontSize:10,fontFamily:T.font,fontWeight:600,transition:"all .12s"});

  const ConnLines=()=>{
    const els=[];
    
    for(const cn of connections){
      const c1=placed.find(c=>c.id===cn.fromComp),c2=placed.find(c=>c.id===cn.toComp);
      if(!c1||!c2)continue;
      const poly1 = componentPolygons[c1.id];
      const poly2 = componentPolygons[c2.id];
      const p1=getPins(c1,RS,poly1).find(p=>p.id===cn.fromPin);
      const p2=getPins(c2,RS,poly2).find(p=>p.id===cn.toPin);
      if(!p1||!p2)continue;
      
      const lc=cn.layer==="GM1"?T.gm1:T.sin;
      const isSel=cn.id===selConn;
      const x1=p1.absX,y1=p1.absY,x2=p2.absX,y2=p2.absY;
      const mx=(x1+x2)/2,my=(y1+y2)/2;
      const width = (cn.width || 1) * RS;
      const radius = (cn.radius || 50) * RS;
      
      // Calculate distance and direction
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const ctrlDist = Math.max(dist * 0.4, radius);
      
      // Use custom angles if set, otherwise calculate from component rotation and pin type
      // Backend uses -angle for nazca (Y-up), canvas needs -angle too to match (since screen is Y-down)
      let angle1Deg, angle2Deg;
      
      if (cn.fromAngle !== undefined) {
        angle1Deg = -cn.fromAngle;  // Negate to match backend
      } else {
        // Auto-calculate: a-pins face left (180°), b-pins face right (0°)
        const baseAngle1 = cn.fromPin.startsWith('a') ? 180 : 0;
        angle1Deg = -(baseAngle1 + (c1.rotation || 0));  // Negate to match backend
      }
      
      if (cn.toAngle !== undefined) {
        angle2Deg = -cn.toAngle;  // Negate to match backend
      } else {
        const baseAngle2 = cn.toPin.startsWith('a') ? 180 : 0;
        angle2Deg = -(baseAngle2 + (c2.rotation || 0));  // Negate to match backend
      }
      
      // Convert to radians for math
      const angle1 = angle1Deg * Math.PI / 180;
      const angle2 = angle2Deg * Math.PI / 180;
      
      // For U-bend: control points go OPPOSITE to pin exit direction (loops around)
      const routeType = cn.routeType || "sbend_p2p";
      const isUbend = routeType === "ubend_p2p";
      
      // Control points direction
      // For U-bend: since we negated angles, we DON'T need to add PI anymore
      // For other routes: use the angles directly
      const dir1 = angle1;
      const dir2 = angle2;
      
      const cx1 = x1 + Math.cos(dir1) * ctrlDist;
      const cy1 = y1 + Math.sin(dir1) * ctrlDist;
      const cx2 = x2 + Math.cos(dir2) * ctrlDist;
      const cy2 = y2 + Math.sin(dir2) * ctrlDist;
      
      // Generate SVG path based on route type
      let pathD = "";
      
      if (routeType === "strt_p2p") {
        // Straight line - ignore pin directions
        pathD = `M ${x1} ${y1} L ${x2} ${y2}`;
      } else if (routeType === "ubend_p2p") {
        // U-bend: extend in direction matching GDS output
        const extDist = ctrlDist * 1.5;
        // Don't add PI - use angles directly for U-bend
        const ux1 = x1 + Math.cos(angle1) * extDist;
        const uy1 = y1 + Math.sin(angle1) * extDist;
        const ux2 = x2 + Math.cos(angle2) * extDist;
        const uy2 = y2 + Math.sin(angle2) * extDist;
        // Use a smooth curve through the extension points
        pathD = `M ${x1} ${y1} C ${ux1} ${uy1}, ${ux2} ${uy2}, ${x2} ${y2}`;
      } else {
        // All other types: smooth bezier using pin exit directions
        pathD = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
      }
      
      els.push(
        <g key={cn.id} style={{cursor:"pointer"}} onClick={e=>{e.stopPropagation();setSelConn(cn.id);setSelected(null)}}>
          {/* Hit area */}
          <path d={pathD} stroke="transparent" strokeWidth={Math.max(width * 3, 14)} fill="none"/>
          {/* Waveguide body */}
          <path d={pathD} 
            stroke={lc} 
            strokeWidth={width} 
            fill="none" 
            strokeOpacity={0.6}
            strokeLinecap="round"
          />
          {/* Center line */}
          <path d={pathD} 
            stroke={lc} 
            strokeWidth={Math.max(width * 0.2, 0.5)} 
            fill="none" 
            strokeOpacity={0.9}
            strokeLinecap="round"
          />
          {/* Selection highlight */}
          {isSel && <path d={pathD} stroke={lc} strokeWidth={width + 4} fill="none" strokeOpacity={0.3} strokeDasharray="6 3"/>}
          {/* Route type label */}
          <text x={mx+7} y={my-5} fill={`${lc}99`} fontSize={8} fontFamily={T.font}>{RT[cn.routeType]?.label}</text>
        </g>
      );
    }
    
    if(pendingPin){
      const pp=pendingPin.wp;
      els.push(<circle key="pend" cx={pp.x*RS} cy={pp.y*RS} r={8} fill="none" stroke={T.warn} strokeWidth={2} strokeDasharray="4 2"/>);
    }
    
    return<>{els}</>;
  };

  const PinDots=()=>{const dots=[];for(const comp of placed){
    const polyData = componentPolygons[comp.id];
    for(const pin of getPins(comp, RS, polyData)){const lc=pin.layer==="GM1"?T.gm1:T.sin;
    const isPend1=pendingPin?.compId===comp.id&&pendingPin?.pinId===pin.id;
    const isPend2=pendingPin2?.compId===comp.id&&pendingPin2?.pinId===pin.id;
    const isPend = isPend1 || isPend2;
    // Different colors: first pin cyan, second pin green
    const pendColor = isPend1 ? "#00acc1" : isPend2 ? "#4caf50" : T.warn;
    // Position label based on pin type: a-pins to the left, b-pins to the right
    const isAPin = pin.id.startsWith('a');
    const labelX = isAPin ? pin.absX - 8 : pin.absX + 8;
    const textAnchor = isAPin ? "end" : "start";
    dots.push(<g key={`${comp.id}-${pin.id}`} style={{cursor:"crosshair"}} onClick={e=>onPinClick(e,comp.id,pin.id,{x:pin.wx,y:pin.wy})}>
      {isPend&&<circle cx={pin.absX} cy={pin.absY} r={11} fill={`${pendColor}18`} stroke={pendColor} strokeWidth={1} strokeDasharray="3 2"/>}
      <circle cx={pin.absX} cy={pin.absY} r={isPend?5:3.5} fill={isPend?pendColor:lc} stroke={T.bg} strokeWidth={1.5}/>
      {/* Pin name label - a-pins left, b-pins right, with background for readability */}
      <text x={labelX} y={pin.absY+4} fill={T.bg} fontSize={10} fontFamily={T.font} fontWeight={700} textAnchor={textAnchor} stroke={T.bg} strokeWidth={3} paintOrder="stroke">{pin.id}</text>
      <text x={labelX} y={pin.absY+4} fill={isPend?pendColor:lc} fontSize={10} fontFamily={T.font} fontWeight={isPend?700:600} textAnchor={textAnchor}>{pin.id}</text>
    </g>)}}return<>{dots}</>};

  const Rulers=()=>{const CW=canvasRef.current?.clientWidth||1600,CH=canvasRef.current?.clientHeight||900;
    const STEPS=[1,2,5,10,20,50,100,200,500,1000,2000],step=STEPS.find(s=>s*S>=45)||2000,maj=step*5,tH=[],tV=[];
    const rulerBg=darkMode?"#161b22":"#edf0f2",rulerBorder=darkMode?"#30363d":"#c0c8d0",rulerCorner=darkMode?"#21262d":"#dde2e6";
    const majColor=darkMode?"#8b949e":"#37474f",minColor=darkMode?"#484f58":"#b0bec5",textColor=darkMode?"#e6edf3":"#1a1a2e";
    for(let u=Math.ceil(-pan.x/S/step)*step;u*S+pan.x<CW;u+=step){const px=u*S+pan.x,iM=u%maj===0;tH.push(<g key={u}><line x1={px} y1={iM?4:14} x2={px} y2={RSZ} stroke={iM?majColor:minColor} strokeWidth={iM?1:.5}/>{iM&&<text x={px+3} y={13} fill={textColor} fontSize={9} fontFamily={T.font} fontWeight={600}>{u}</text>}</g>)}
    for(let u=Math.ceil(-pan.y/S/step)*step;u*S+pan.y<CH;u+=step){const py=u*S+pan.y,iM=u%maj===0;tV.push(<g key={u}><line x1={iM?6:18} y1={py} x2={RSZ} y2={py} stroke={iM?majColor:minColor} strokeWidth={iM?1:.5}/>{iM&&<text x={14} y={py+3} fill={textColor} fontSize={9} fontFamily={T.font} fontWeight={600} textAnchor="middle" transform={`rotate(-90,14,${py+3})`}>{u}</text>}</g>)}
    return<><svg style={{position:"absolute",left:0,top:0,width:"100%",height:RSZ,pointerEvents:"none",background:rulerBg,borderBottom:`1px solid ${rulerBorder}`,zIndex:5}}><rect width={RSZ} height={RSZ} fill={rulerCorner}/>{tH}</svg>
      <svg style={{position:"absolute",left:0,top:RSZ,width:RSZ,height:`calc(100% - ${RSZ}px)`,pointerEvents:"none",background:rulerBg,borderRight:`1px solid ${rulerBorder}`,zIndex:5}}>{tV}</svg></>};

  return(
    <div style={{width:"100vw",height:"100vh",display:"flex",flexDirection:"column",fontFamily:T.font,color:T.text,overflow:"hidden",userSelect:"none",background:T.bg}}>
      {/* TOP BAR */}
      <div style={{height:46,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",padding:"0 16px",gap:10,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginRight:6}}>
          <div style={{width:26,height:26,borderRadius:5,background:`linear-gradient(135deg,${T.accent}33,${T.accent}0a)`,border:`1px solid ${T.accent}33`,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:13,color:T.accent}}>◈</span></div>
          <div><div style={{fontSize:10,fontWeight:700,color:T.textBright,letterSpacing:1.5,lineHeight:1}}>PHOTONIC</div><div style={{fontSize:7,color:T.textDim,letterSpacing:2,lineHeight:1,marginTop:1}}>DESIGNER</div></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 8px",borderRadius:10,fontSize:8,color:st.c,background:`${st.c}11`,border:`1px solid ${st.c}22`}}><div style={{width:5,height:5,borderRadius:"50%",background:st.c}}/>{st.t}</div>
        
        {/* SESSION DROPDOWN */}
        <div style={{position:"relative",marginLeft:10}}>
          <button 
            onClick={()=>setSessionDropdown(!sessionDropdown)}
            style={{
              display:"flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:5,cursor:"pointer",
              background:darkMode?"#30363d":T.accent+"18",
              border:`1px solid ${T.accent}`,
              color:T.accent,fontSize:10,fontFamily:T.sans,fontWeight:600
            }}>
            <span style={{maxWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{activeSession?.name||"Untitled"}</span>
            <span style={{fontSize:8,opacity:0.7}}>▼</span>
          </button>
          {sessionDropdown&&<>
            <div style={{position:"fixed",inset:0,zIndex:99}} onClick={()=>setSessionDropdown(false)}/>
            <div style={{
              position:"absolute",top:"100%",left:0,marginTop:4,
              background:T.bg2,border:`1px solid ${T.border}`,borderRadius:8,
              boxShadow:"0 4px 20px #00000033",zIndex:100,minWidth:180,overflow:"hidden"
            }}>
              <div style={{padding:"8px 10px",borderBottom:`1px solid ${T.border}`,fontSize:9,color:T.textDim,fontFamily:T.sans,fontWeight:600,letterSpacing:1}}>SESSIONS</div>
              <div style={{maxHeight:200,overflowY:"auto"}}>
                {sessionsData.sessions.map(s=>(
                  <div key={s.id} 
                    style={{
                      display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 12px",cursor:"pointer",
                      background:s.id===activeSessionId?(darkMode?"#30363d":T.accent+"12"):"transparent",
                      borderLeft:s.id===activeSessionId?`3px solid ${T.accent}`:"3px solid transparent"
                    }}
                    onMouseEnter={e=>{if(s.id!==activeSessionId)e.currentTarget.style.background=darkMode?"#21262d":T.bg3}}
                    onMouseLeave={e=>{if(s.id!==activeSessionId)e.currentTarget.style.background="transparent"}}
                    onClick={()=>{switchSession(s.id);setSessionDropdown(false)}}>
                    <span style={{fontSize:11,color:s.id===activeSessionId?T.accent:T.text,fontFamily:T.sans,fontWeight:s.id===activeSessionId?600:400}}>{s.name}</span>
                    <div style={{display:"flex",gap:6}}>
                      <span onClick={e=>{e.stopPropagation();setSessionDropdown(false);renameSession(s.id)}} 
                        style={{fontSize:10,color:T.textDim,cursor:"pointer",padding:"2px 4px"}}
                        onMouseEnter={e=>e.target.style.color=T.accent}
                        onMouseLeave={e=>e.target.style.color=T.textDim}>✎</span>
                      {sessionsData.sessions.length>1&&<span onClick={e=>{e.stopPropagation();setSessionDropdown(false);deleteSession(s.id)}} 
                        style={{fontSize:10,color:T.textDim,cursor:"pointer",padding:"2px 4px"}}
                        onMouseEnter={e=>e.target.style.color=T.error}
                        onMouseLeave={e=>e.target.style.color=T.textDim}>✕</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{borderTop:`1px solid ${T.border}`,padding:"6px 8px"}}>
                <button onClick={()=>{setSessionDropdown(false);newSession()}} 
                  style={{width:"100%",background:"transparent",border:`1px dashed ${T.border}`,color:T.textDim,padding:"6px 10px",borderRadius:5,cursor:"pointer",fontSize:10,fontFamily:T.sans,display:"flex",alignItems:"center",justifyContent:"center",gap:4}}
                  onMouseEnter={e=>{e.target.style.borderColor=T.accent;e.target.style.color=T.accent}}
                  onMouseLeave={e=>{e.target.style.borderColor=T.border;e.target.style.color=T.textDim}}>
                  + New Session
                </button>
              </div>
            </div>
          </>}
        </div>
        
        <div style={{flex:1}}/>
        <select value={routeType} onChange={e=>setRouteType(e.target.value)} title="Route type for new connections"
          style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.textDim,fontSize:9,fontFamily:T.font,cursor:"pointer",outline:"none",borderRadius:4,padding:"4px 6px"}}>
          {Object.entries(RT).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
        </select>
        <div style={{display:"flex",alignItems:"center",gap:3,background:T.bg3,border:`1px solid ${T.border}`,borderRadius:5,padding:"3px 6px",height:28}}>
          <button onClick={()=>setZoom(z=>Math.max(z/1.25,.05))} style={{background:"none",border:"none",cursor:"pointer",color:T.textDim,fontSize:13,padding:"0 2px"}}>−</button>
          <span style={{fontSize:10,color:T.textBright,minWidth:36,textAlign:"center",fontVariantNumeric:"tabular-nums"}}>{Math.round(zoom*100)}%</span>
          <button onClick={()=>setZoom(z=>Math.min(z*1.25,100))} style={{background:"none",border:"none",cursor:"pointer",color:T.textDim,fontSize:13,padding:"0 2px"}}>+</button>
          <button onClick={()=>{setZoom(1);setPan({x:400,y:300})}} style={{background:"none",border:"none",cursor:"pointer",color:T.textDim,fontSize:10,padding:"0 3px"}}>⌂</button>
          <div style={{width:1,height:12,background:T.border}}/>
          <button onClick={()=>setGridSnap(g=>!g)} title="Toggle grid snap" style={{...btn(gridSnap,T.success),padding:"2px 5px",fontSize:8,borderRadius:3}}>⊞</button>
          {gridSnap&&<>
            <button onClick={()=>setAutoGrid(a=>!a)} title={autoGrid?"Auto grid (zoom-based)":"Manual grid"} 
              style={{...btn(autoGrid,"#7c4dff"),padding:"2px 5px",fontSize:7,borderRadius:3,minWidth:28}}>
              {autoGrid?"Auto":"Man"}
            </button>
            {autoGrid ? (
              <span style={{fontSize:8,color:"#7c4dff",fontFamily:T.font,minWidth:36}}>{effectiveGridSize<0.1?effectiveGridSize.toFixed(2):effectiveGridSize<1?effectiveGridSize.toFixed(1):effectiveGridSize}µm</span>
            ) : (
              <select value={gridSize} onChange={e=>setGridSize(Number(e.target.value))} style={{background:"transparent",border:"none",color:T.success,fontSize:8,fontFamily:T.font,cursor:"pointer",outline:"none",width:45}}>
                {GRID_OPTIONS.map(g=><option key={g} value={g}>{g<0.1?g.toFixed(2):g<1?g.toFixed(1):g}µm</option>)}
              </select>
            )}
          </>}
        </div>
        {/* Align mode toggle */}
        <button onClick={()=>{setAlignMode(m=>{if(!m)setMultiSel(selected?[selected]:[]);return!m});setPinAlignMode(false);setRulerMode(false)}}
          style={{...btn(alignMode,"#e65100"),padding:"4px 8px",fontSize:9}}>
          {alignMode?"✓ Align":"Align"}
        </button>
        <button onClick={()=>{setPinAlignMode(m=>!m);setAlignMode(false);setRulerMode(false);if(!pinAlignMode)setPendingPin(null)}}
          title="Pin Align: Click two pins to align components (no connection created)"
          style={{...btn(pinAlignMode,"#00acc1"),padding:"4px 8px",fontSize:9}}>
          {pinAlignMode?"✓ Pin Align":"Pin Align"}
        </button>
        <button onClick={()=>{setRulerMode(m=>!m);setAlignMode(false);setPinAlignMode(false);setRulerDragging(null)}}
          title="Ruler: Click for crosshair, drag for measure. Ctrl+K to clear all."
          style={{...btn(rulerMode,"#6a1b9a"),padding:"4px 8px",fontSize:9}}>
          {rulerMode?"✓ Ruler":"📏 Ruler"}
        </button>
        <button onClick={()=>setShowCode(s=>!s)} style={{...btn(showCode),padding:"4px 8px",fontSize:9}}>
          {showCode?"Canvas":"Code"}
        </button>
        <button onClick={previewGDS} disabled={previewing||!placed.length||!nazcaOk}
          title="Preview GDS"
          style={{background:nazcaOk&&placed.length?"#7b1fa2":T.bg3,border:`1px solid ${nazcaOk&&placed.length?"#7b1fa2":T.border}`,
            color:nazcaOk&&placed.length?"#fff":T.textDim,padding:"4px 8px",borderRadius:4,
            cursor:nazcaOk&&placed.length?"pointer":"not-allowed",fontSize:9,fontFamily:T.sans}}>
          {previewing?"⏳":"Preview"}
        </button>
        {/* Import GDS/OAS button */}
        <input type="file" ref={gdsInputRef} accept=".gds,.gds2,.GDS,.oas,.oasis,.OAS,.OASIS" style={{display:"none"}} 
          onChange={e=>e.target.files?.[0]&&importGDS(e.target.files[0])}/>
        <button onClick={()=>gdsInputRef.current?.click()} disabled={importing||!nazcaOk}
          title="Import GDS/OAS"
          style={{background:nazcaOk?"#ff6f00":T.bg3,border:`1px solid ${nazcaOk?"#ff6f00":T.border}`,
            color:nazcaOk?"#fff":T.textDim,padding:"4px 8px",borderRadius:4,
            cursor:nazcaOk?"pointer":"not-allowed",fontSize:9,fontFamily:T.sans}}>
          {importing?"⏳":"Import"}
        </button>
        <button onClick={exportGDS} disabled={exporting||!placed.length||!nazcaOk}
          title="Export GDS"
          style={{background:nazcaOk&&placed.length?"#1565c0":T.bg3,border:`1px solid ${nazcaOk&&placed.length?"#1565c0":T.border}`,
            color:nazcaOk&&placed.length?"#fff":T.textDim,padding:"4px 8px",borderRadius:4,
            cursor:nazcaOk&&placed.length?"pointer":"not-allowed",fontSize:9,fontFamily:T.sans}}>
          {exporting?"⏳":"Export"}
        </button>
        <button onClick={runDRC} disabled={drcRunning||!placed.length}
          title="Run DRC (IHP Graphene Design Rules)"
          style={{background:placed.length?(drcResults?.ok===false?"#d32f2f":drcResults?.ok===true?"#2e7d32":"#7b1fa2"):T.bg3,
            border:`1px solid ${placed.length?(drcResults?.ok===false?"#d32f2f":drcResults?.ok===true?"#2e7d32":"#7b1fa2"):T.border}`,
            color:placed.length?"#fff":T.textDim,padding:"4px 8px",borderRadius:4,
            cursor:placed.length?"pointer":"not-allowed",fontSize:9,fontFamily:T.sans}}>
          {drcRunning?"⏳":drcResults?.ok===false?"⚠ DRC":drcResults?.ok===true?"✓ DRC":"DRC"}
        </button>
        <button onClick={()=>setShowPdkManager(true)}
          title="PDK Manager - Switch or create custom PDKs"
          style={{background:"#00695c",border:"1px solid #00695c",color:"#fff",padding:"4px 8px",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:T.sans}}>
          PDK
        </button>
        <button onClick={async()=>{if(!nazcaOk||!placed.length)return;setExportMsg("Opening KLayout…");
          try{const r=await fetch(`${API}/open_klayout`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({components:placed,connections})});
            const d=await r.json();setExportMsg(d.ok?`✓ ${d.message}`:`✗ ${d.error}`);setTimeout(()=>setExportMsg(""),5000)}
          catch(e){setExportMsg(`✗ ${e.message}`)}}}
          disabled={!placed.length||!nazcaOk}
          title="Open in KLayout"
          style={{background:nazcaOk&&placed.length?"#2e7d32":T.bg3,border:`1px solid ${nazcaOk&&placed.length?"#2e7d32":T.border}`,
            color:nazcaOk&&placed.length?"#fff":T.textDim,padding:"4px 8px",borderRadius:4,
            cursor:nazcaOk&&placed.length?"pointer":"not-allowed",fontSize:9,fontFamily:T.sans}}>
          KLayout
        </button>
        <button onClick={()=>window.location.reload()} title="Refresh"
          style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,padding:"4px 8px",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:T.sans}}>
          ↻
        </button>
        <button onClick={()=>setDarkMode(!darkMode)} title={darkMode?"Light mode":"Dark mode"}
          style={{background:darkMode?"#fbbf24":"#1e293b",border:`1px solid ${darkMode?"#f59e0b":"#334155"}`,
            color:darkMode?"#1e293b":"#f8fafc",padding:"4px 8px",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:T.sans}}>
          {darkMode?"☀":"🌙"}
        </button>
      </div>
      {pendingPin&&<div style={{background:`${pinAlignMode?"#00acc1":T.warn}0d`,borderBottom:`1px solid ${pinAlignMode?"#00acc1":T.warn}22`,padding:"5px 20px",fontSize:10,color:pinAlignMode?"#00acc1":T.warn,flexShrink:0,fontFamily:T.sans}}>
        {pinAlignMode ? "🔗 Pin Align: " : ""}Pin <strong style={{fontFamily:T.font}}>{pendingPin.pinId}</strong> selected — click target pin {pinAlignMode ? "to align" : "to connect"} · <span style={{opacity:.5}}>Esc cancel</span>
      </div>}
      {pinAlignMode&&!pendingPin&&<div style={{background:"#00acc10d",borderBottom:"1px solid #00acc122",padding:"5px 20px",fontSize:10,color:"#00acc1",flexShrink:0,fontFamily:T.sans}}>
        🔗 <strong>Pin Align Mode</strong> — Click first pin (cyan), then second pin (green) · <span style={{opacity:.5}}>Esc to exit</span>
      </div>}
      {pinAlignMode&&pendingPin&&!pendingPin2&&<div style={{background:"#00acc10d",borderBottom:"1px solid #00acc122",padding:"5px 20px",fontSize:10,color:"#00acc1",flexShrink:0,fontFamily:T.sans}}>
        🔗 First pin: <strong>{pendingPin.compId}.{pendingPin.pinId}</strong> (cyan) — Now click second pin · <span style={{opacity:.5}}>Esc to cancel</span>
      </div>}
      {pinAlignMode&&pendingPin&&pendingPin2&&(()=>{
        const comp1 = placed.find(c=>c.id===pendingPin.compId);
        const comp2 = placed.find(c=>c.id===pendingPin2.compId);
        const name1 = comp1?.id?.slice(0,10) || "Comp1";
        const name2 = comp2?.id?.slice(0,10) || "Comp2";
        
        // Get pin world positions (recalculate each render)
        const getAbsPinPos = (comp, pinId) => {
          if (!comp) return {x: 0, y: 0};
          const pins = getPins(comp, S, componentPolygons[comp.id]);
          const pin = pins.find(p=>p.id===pinId);
          return pin ? {x: pin.wx, y: pin.wy} : {x: comp.x, y: comp.y};
        };
        
        const p1Pos = getAbsPinPos(comp1, pendingPin.pinId);
        const p2Pos = getAbsPinPos(comp2, pendingPin2.pinId);
        
        // Check if pins are currently touching (within 0.01µm)
        const pinsTouching = Math.abs(p1Pos.x - p2Pos.x) < 0.01 && Math.abs(p1Pos.y - p2Pos.y) < 0.01;
        
        // Alignment functions - DO NOT clear pendingPin/pendingPin2 so toolbar stays active
        const alignMatchXY = (moveComp2) => {
          if(comp1 && comp2){
            const dx = p1Pos.x - p2Pos.x;
            const dy = p1Pos.y - p2Pos.y;
            if(moveComp2){
              setPlaced(prev=>prev.map(c=>c.id===comp2.id?{...c,x:c.x+dx,y:c.y+dy}:c));
            } else {
              setPlaced(prev=>prev.map(c=>c.id===comp1.id?{...c,x:c.x-dx,y:c.y-dy}:c));
            }
            setExportMsg(`✓ Pins touching`);
            setTimeout(()=>setExportMsg(""),2000);
          }
        };
        
        const alignMatchX = (moveComp2) => {
          if(comp1 && comp2){
            const dx = p1Pos.x - p2Pos.x;
            if(moveComp2){
              setPlaced(prev=>prev.map(c=>c.id===comp2.id?{...c,x:c.x+dx}:c));
            } else {
              setPlaced(prev=>prev.map(c=>c.id===comp1.id?{...c,x:c.x-dx}:c));
            }
            setExportMsg(`✓ Pins X aligned`);
            setTimeout(()=>setExportMsg(""),2000);
          }
        };
        
        const alignMatchY = (moveComp2) => {
          if(comp1 && comp2){
            const dy = p1Pos.y - p2Pos.y;
            if(moveComp2){
              setPlaced(prev=>prev.map(c=>c.id===comp2.id?{...c,y:c.y+dy}:c));
            } else {
              setPlaced(prev=>prev.map(c=>c.id===comp1.id?{...c,y:c.y-dy}:c));
            }
            setExportMsg(`✓ Pins Y aligned`);
            setTimeout(()=>setExportMsg(""),2000);
          }
        };
        
        // Separate functions - move comp2 away from comp1 by offset
        const separateX = (offset) => {
          if(comp1 && comp2){
            setPlaced(prev=>prev.map(c=>c.id===comp2.id?{...c,x:c.x+offset}:c));
            setExportMsg(`✓ Separated by ${offset}µm in X`);
            setTimeout(()=>setExportMsg(""),2000);
          }
        };
        
        const separateY = (offset) => {
          if(comp1 && comp2){
            setPlaced(prev=>prev.map(c=>c.id===comp2.id?{...c,y:c.y+offset}:c));
            setExportMsg(`✓ Separated by ${offset}µm in Y`);
            setTimeout(()=>setExportMsg(""),2000);
          }
        };
        
        const done = () => {
          setPendingPin(null);
          setPendingPin2(null);
        };
        
        const btnBase = {border:"none",color:"#fff",padding:"4px 10px",borderRadius:4,cursor:"pointer",fontSize:9,fontWeight:600};
        const btnTouch = {...btnBase, background:"#00acc1"};
        const btnMatchX = {...btnBase, background:"#5c6bc0"};
        const btnMatchY = {...btnBase, background:"#26a69a"};
        const btnSep = {...btnBase, background:"#ff7043", padding:"3px 8px", fontSize:8};
        const btnDone = {...btnBase, background:"#78909c", padding:"3px 8px"};
        const inputStyle = {width:50,padding:"3px 5px",fontSize:9,border:"1px solid #ccc",borderRadius:3,textAlign:"right"};
        const labelStyle = {fontSize:8,color:T.textDim,marginRight:2};
        
        return (
          <div style={{background:"#00acc10d",borderBottom:"1px solid #00acc122",padding:"6px 12px",fontSize:10,color:"#00acc1",flexShrink:0,fontFamily:T.sans}}>
            {/* Row 1: Pin names */}
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
              <span>🔗 Pin 1: <strong style={{color:"#00acc1"}}>{name1}.{pendingPin.pinId}</strong></span>
              <span>↔</span>
              <span>Pin 2: <strong style={{color:"#4caf50"}}>{name2}.{pendingPin2.pinId}</strong></span>
              {pinsTouching && <span style={{background:"#4caf50",color:"#fff",padding:"1px 6px",borderRadius:10,fontSize:8,marginLeft:8}}>✓ Touching</span>}
            </div>
            
            {/* Row 2: Alignment - with clear labels showing which component moves */}
            <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:6,flexWrap:"wrap"}}>
              <span style={labelStyle}>Move <strong style={{color:"#4caf50"}}>{name2}</strong>:</span>
              <button onClick={()=>alignMatchXY(true)} style={btnTouch} title={`Move ${name2} so pins touch`}>Touch</button>
              <button onClick={()=>alignMatchX(true)} style={btnMatchX} title={`Align ${name2} pin X to ${name1} pin X`}>Match X</button>
              <button onClick={()=>alignMatchY(true)} style={btnMatchY} title={`Align ${name2} pin Y to ${name1} pin Y`}>Match Y</button>
              
              <span style={{opacity:0.3,margin:"0 4px"}}>|</span>
              <span style={labelStyle}>Move <strong style={{color:"#00acc1"}}>{name1}</strong>:</span>
              <button onClick={()=>alignMatchXY(false)} style={{...btnTouch,background:"#0097a7"}} title={`Move ${name1} so pins touch`}>Touch</button>
              <button onClick={()=>alignMatchX(false)} style={{...btnMatchX,background:"#3f51b5"}} title={`Align ${name1} pin X to ${name2} pin X`}>Match X</button>
              <button onClick={()=>alignMatchY(false)} style={{...btnMatchY,background:"#00897b"}} title={`Align ${name1} pin Y to ${name2} pin Y`}>Match Y</button>
            </div>
            
            {/* Row 3: Separate controls - only active when pins are touching */}
            <div style={{display:"flex",alignItems:"center",gap:6,opacity:pinsTouching?1:0.4}}>
              <span style={labelStyle}>Separate {name2} by:</span>
              <span style={{fontSize:8}}>X</span>
              <input type="number" value={pinOffsetX} step={1} onChange={e=>setPinOffsetX(parseFloat(e.target.value)||0)} 
                style={inputStyle} disabled={!pinsTouching}/>
              <span style={{fontSize:8}}>µm</span>
              <button onClick={()=>separateX(pinOffsetX)} style={btnSep} disabled={!pinsTouching} 
                title={pinsTouching?`Move ${name2} by ${pinOffsetX}µm in X`:"Touch first"}>→ Sep X</button>
              
              <span style={{opacity:0.3,margin:"0 2px"}}>|</span>
              <span style={{fontSize:8}}>Y</span>
              <input type="number" value={pinOffsetY} step={1} onChange={e=>setPinOffsetY(parseFloat(e.target.value)||0)} 
                style={inputStyle} disabled={!pinsTouching}/>
              <span style={{fontSize:8}}>µm</span>
              <button onClick={()=>separateY(pinOffsetY)} style={btnSep} disabled={!pinsTouching}
                title={pinsTouching?`Move ${name2} by ${pinOffsetY}µm in Y`:"Touch first"}>↓ Sep Y</button>
              
              <span style={{flex:1}}/>
              <button onClick={done} style={btnDone} title="Done - exit pin align mode">✓ Done</button>
              <span style={{opacity:.5,fontSize:8,marginLeft:4}}>Esc cancel</span>
            </div>
          </div>
        );
      })()}
      {exportMsg&&<div style={{background:exportMsg[0]==="✓"?`${T.success}0d`:`${T.error}0d`,color:exportMsg[0]==="✓"?T.success:T.error,padding:"5px 20px",fontSize:10,borderBottom:`1px solid ${exportMsg[0]==="✓"?T.success:T.error}22`,flexShrink:0,fontFamily:T.sans}}>{exportMsg}</div>}

      {/* DRC Results Panel */}
      {showDrcPanel && drcResults && (
        <div style={{background:drcResults.ok?`${T.success}0a`:`${T.error}0a`,borderBottom:`2px solid ${drcResults.ok?T.success:T.error}`,padding:"8px 20px",flexShrink:0,fontFamily:T.sans}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:12,fontWeight:700,color:drcResults.ok?T.success:T.error}}>
                {drcResults.ok ? "✓ DRC Passed" : "⚠ DRC Violations"}
              </span>
              <span style={{fontSize:10,color:T.textDim}}>{drcResults.summary}</span>
            </div>
            <div style={{display:"flex",gap:6}}>
              <button onClick={runDRC} style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,padding:"2px 8px",borderRadius:3,cursor:"pointer",fontSize:8}}>
                ↻ Re-run
              </button>
              <button onClick={()=>setShowDrcPanel(false)} style={{background:"transparent",border:"none",color:T.textDim,cursor:"pointer",fontSize:12,padding:"0 4px"}}>
                ✕
              </button>
            </div>
          </div>
          
          {/* Errors */}
          {drcResults.errors && drcResults.errors.length > 0 && (
            <div style={{marginBottom:6}}>
              <div style={{fontSize:9,fontWeight:600,color:T.error,marginBottom:3}}>Errors ({drcResults.errors.length})</div>
              <div style={{maxHeight:100,overflowY:"auto",background:T.bg,borderRadius:4,padding:6}}>
                {drcResults.errors.map((e, i) => (
                  <div key={i} style={{fontSize:9,color:T.error,marginBottom:3,display:"flex",gap:6}}>
                    <span style={{fontWeight:600,minWidth:50}}>{e.rule}</span>
                    <span style={{color:T.textDim}}>{e.comp_id}</span>
                    <span style={{flex:1}}>{e.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* Warnings */}
          {drcResults.warnings && drcResults.warnings.length > 0 && (
            <div>
              <div style={{fontSize:9,fontWeight:600,color:T.warn,marginBottom:3}}>Warnings ({drcResults.warnings.length})</div>
              <div style={{maxHeight:80,overflowY:"auto",background:T.bg,borderRadius:4,padding:6}}>
                {drcResults.warnings.map((w, i) => (
                  <div key={i} style={{fontSize:9,color:T.warn,marginBottom:3,display:"flex",gap:6}}>
                    <span style={{fontWeight:600,minWidth:50}}>{w.rule}</span>
                    <span style={{color:T.textDim}}>{w.comp_id}</span>
                    <span style={{flex:1}}>{w.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {drcResults.ok && (
            <div style={{fontSize:9,color:T.success}}>
              All IHP Graphene design rules passed! Ready for fabrication.
            </div>
          )}
        </div>
      )}

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        {/* LEFT PANEL */}
        <div style={{width:230,background:T.bg2,borderRight:`1px solid ${T.border}`,display:"flex",flexDirection:"column",flexShrink:0,overflowY:"auto"}}>
          <div style={{padding:"12px 12px 6px",borderBottom:`1px solid ${T.border}`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontSize:14,fontWeight:800,color:T.textBright,fontFamily:T.sans}}>Components</div>
              <div style={{display:"flex",gap:2}}>
                <button onClick={()=>setOpenGroups(prev=>{const newState={};COMP_GROUPS.forEach(g=>newState[g.id]=true);newState.customBlocks=true;return newState})} 
                  title="Expand All" style={{background:"transparent",border:"none",color:T.textDim,cursor:"pointer",padding:"2px 4px",fontSize:10}}>⊞</button>
                <button onClick={()=>setOpenGroups(prev=>{const newState={};COMP_GROUPS.forEach(g=>newState[g.id]=false);newState.customBlocks=false;return newState})} 
                  title="Collapse All" style={{background:"transparent",border:"none",color:T.textDim,cursor:"pointer",padding:"2px 4px",fontSize:10}}>⊟</button>
              </div>
            </div>
            <div style={{fontSize:9,color:T.textDim,marginTop:2,fontFamily:T.sans}}>Click to add · Ctrl+A select all</div>
          </div>
          <div style={{flex:1,overflowY:"auto"}}>
            {COMP_GROUPS.map(grp=>{
              const groupTypes=grp.types.filter(t=>DEFS[t]);
              if(!groupTypes.length)return null;
              const isOpen=openGroups[grp.id]!==false;
              return <div key={grp.id}>
                {/* Collapsible group header */}
                <div onClick={()=>setOpenGroups(prev=>({...prev,[grp.id]:!isOpen}))}
                  style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:6,cursor:"pointer",
                    borderBottom:`1px solid ${T.border}`,background:isOpen?(darkMode?"#1c2433":T.bg3):"transparent",
                    transition:"background .15s"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=darkMode?"#252d3a":T.bg4}}
                  onMouseLeave={e=>{e.currentTarget.style.background=isOpen?(darkMode?"#1c2433":T.bg3):"transparent"}}>
                  <span style={{fontSize:8,color:T.textDim,transition:"transform .2s",transform:isOpen?"rotate(90deg)":"rotate(0deg)",display:"inline-block"}}>▶</span>
                  <span style={{fontSize:12}}>{grp.label.split(" ")[0]}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,fontWeight:700,color:T.textBright,fontFamily:T.sans}}>{grp.label.split(" ").slice(1).join(" ")}</div>
                    <div style={{fontSize:8,color:T.textDim,fontFamily:T.sans,lineHeight:1.2}}>{grp.desc}</div>
                  </div>
                  <span style={{fontSize:9,color:T.textDim,background:T.bg3,borderRadius:8,padding:"1px 6px",fontFamily:T.font}}>{groupTypes.length}</span>
                </div>
                {/* Collapsible content */}
                {isOpen&&<div style={{padding:"4px 8px 6px",background:darkMode?T.bg:T.bg2}}>
                  {groupTypes.map(t=>{const d=DEFS[t];return(
                    <button key={t} onClick={()=>addComp(t)} title={d.desc||d.label}
                      style={{background:"transparent",border:"1px solid transparent",color:T.textDim,padding:"5px 8px",borderRadius:5,cursor:"pointer",textAlign:"left",
                        display:"flex",alignItems:"center",gap:8,fontFamily:T.sans,transition:"all .12s",width:"100%",boxSizing:"border-box"}}
                      onMouseEnter={e=>{e.currentTarget.style.background=`${d.color}18`;e.currentTarget.style.borderColor=`${d.color}40`;e.currentTarget.style.color=d.color}}
                      onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="transparent";e.currentTarget.style.color=T.textDim}}>
                      <span style={{fontSize:15,width:22,textAlign:"center",color:d.color,opacity:0.8}}>{d.icon}</span>
                      <div>
                        <div style={{fontSize:11,fontWeight:700,lineHeight:1.2}}>{d.label}</div>
                        {d.desc&&<div style={{fontSize:8,color:T.textDim,fontWeight:400,lineHeight:1.2,marginTop:1,opacity:0.7}}>{d.desc.length>35?d.desc.slice(0,35)+"…":d.desc}</div>}
                      </div>
                    </button>)})}
                </div>}
              </div>})}
            
            {/* Custom Building Blocks Section */}
            {customBlocks.length > 0 && (
              <div>
                <div onClick={()=>setOpenGroups(prev=>({...prev,customBlocks:!(openGroups.customBlocks??true)}))}
                  style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:6,cursor:"pointer",
                    borderBottom:`1px solid ${T.border}`,background:(openGroups.customBlocks??true)?(darkMode?"#2d1f4e":"#f3e5f5"):"transparent",
                    transition:"background .15s"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=darkMode?"#3d2a6e":"#e1bee7"}}
                  onMouseLeave={e=>{e.currentTarget.style.background=(openGroups.customBlocks??true)?(darkMode?"#2d1f4e":"#f3e5f5"):"transparent"}}>
                  <span style={{fontSize:8,color:"#9c27b0",transition:"transform .2s",transform:(openGroups.customBlocks??true)?"rotate(90deg)":"rotate(0deg)",display:"inline-block"}}>▶</span>
                  <span style={{fontSize:12}}>💾</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,fontWeight:700,color:"#9c27b0",fontFamily:T.sans}}>My Building Blocks</div>
                    <div style={{fontSize:8,color:T.textDim,fontFamily:T.sans,lineHeight:1.2}}>Saved component presets</div>
                  </div>
                  <span style={{fontSize:9,color:"#9c27b0",background:`#9c27b020`,borderRadius:8,padding:"1px 6px",fontFamily:T.font}}>{customBlocks.length}</span>
                </div>
                {(openGroups.customBlocks??true)&&<div style={{padding:"4px 8px 6px",background:darkMode?T.bg:T.bg2}}>
                  {customBlocks.map(block=>{
                    // Handle group blocks
                    if (block.isGroup) {
                      return (
                        <div key={block.id} style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
                          <button onClick={()=>{
                            // Add all components from the group
                            const baseX = 200 + Math.random() * 100;
                            const baseY = 200 + Math.random() * 100;
                            const newComps = block.components.map(comp => {
                              const id = `${comp.type.replace(/_/g,"")}_${++idCtr.current}`;
                              return {
                                id,
                                type: comp.type,
                                x: baseX + comp.relX,
                                y: baseY + comp.relY,
                                rotation: comp.rotation || 0,
                                params: { ...comp.params }
                              };
                            });
                            setPlaced(p => [...p, ...newComps]);
                          }} title={`Add ${block.name}`}
                            style={{flex:1,background:"transparent",border:"1px solid transparent",color:T.textDim,padding:"5px 8px",borderRadius:5,cursor:"pointer",textAlign:"left",
                              display:"flex",alignItems:"center",gap:8,fontFamily:T.sans,transition:"all .12s"}}
                            onMouseEnter={e=>{e.currentTarget.style.background=`#9c27b018`;e.currentTarget.style.borderColor=`#9c27b040`;e.currentTarget.style.color="#9c27b0"}}
                            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="transparent";e.currentTarget.style.color=T.textDim}}>
                            <span style={{fontSize:15,width:22,textAlign:"center",color:"#9c27b0",opacity:0.8}}>{block.icon}</span>
                            <div>
                              <div style={{fontSize:11,fontWeight:700,lineHeight:1.2}}>{block.name}</div>
                              <div style={{fontSize:8,color:T.textDim,fontWeight:400,lineHeight:1.2,marginTop:1,opacity:0.7}}>{block.components.length} components</div>
                            </div>
                          </button>
                          <button onClick={()=>deleteCustomBlock(block.id)} title="Delete"
                            style={{background:"transparent",border:"none",color:T.error,cursor:"pointer",padding:"4px",fontSize:10,opacity:0.5}}
                            onMouseEnter={e=>{e.currentTarget.style.opacity="1"}}
                            onMouseLeave={e=>{e.currentTarget.style.opacity="0.5"}}>✕</button>
                        </div>
                      );
                    }
                    
                    // Single component block
                    const baseDef = DEFS[block.baseType];
                    if (!baseDef) return null;
                    return (
                      <div key={block.id} style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
                        <button onClick={()=>{
                          // Add component with saved params
                          const id = `${block.baseType.replace(/_/g,"")}_${++idCtr.current}`;
                          const newComp = {id,type:block.baseType,x:200+Math.random()*100,y:200+Math.random()*100,rotation:0,params:{...block.params}};
                          setPlaced(p=>[...p, newComp]);
                          
                          // For imported_gds, also set polygon data
                          if (block.baseType === "imported_gds" && block.params?.all_polygons) {
                            const polys = block.params.all_polygons;
                            const bbox = block.params.bbox || {x_min:0,y_min:0,x_max:100,y_max:0};
                            
                            // Find narrow waveguides for pin placement
                            const narrowThreshold = 2.0;
                            const narrowWgs = [];
                            polys.forEach(poly => {
                              if(poly.layer !== 119) return;
                              let pMinX=Infinity, pMaxX=-Infinity, pMinY=Infinity, pMaxY=-Infinity;
                              poly.points.forEach(([x,y]) => {
                                pMinX = Math.min(pMinX, x);
                                pMaxX = Math.max(pMaxX, x);
                                pMinY = Math.min(pMinY, y);
                                pMaxY = Math.max(pMaxY, y);
                              });
                              if((pMaxY - pMinY) < narrowThreshold) {
                                narrowWgs.push({minX: pMinX, maxX: pMaxX, minY: pMinY, maxY: pMaxY});
                              }
                            });
                            
                            let leftPinX = bbox.x_min, leftPinY = (bbox.y_min + bbox.y_max) / 2;
                            let rightPinX = bbox.x_max, rightPinY = leftPinY;
                            
                            if(narrowWgs.length > 0) {
                              const leftmost = narrowWgs.reduce((a,b) => a.minX < b.minX ? a : b);
                              const rightmost = narrowWgs.reduce((a,b) => a.maxX > b.maxX ? a : b);
                              leftPinX = leftmost.minX;
                              leftPinY = (leftmost.minY + leftmost.maxY) / 2;
                              rightPinX = rightmost.maxX;
                              rightPinY = (rightmost.minY + rightmost.maxY) / 2;
                            }
                            
                            setComponentPolygons(prev => ({
                              ...prev,
                              [id]: {
                                polygons: polys,
                                bbox: bbox,
                                pins: {a0: {x: 0, y: 0}, b0: {x: rightPinX - leftPinX, y: rightPinY - leftPinY}},
                                cacheKey: `block_${id}`
                              }
                            }));
                          }
                        }} title={`Add ${block.name}`}
                          style={{flex:1,background:"transparent",border:"1px solid transparent",color:T.textDim,padding:"5px 8px",borderRadius:5,cursor:"pointer",textAlign:"left",
                            display:"flex",alignItems:"center",gap:8,fontFamily:T.sans,transition:"all .12s"}}
                          onMouseEnter={e=>{e.currentTarget.style.background=`#9c27b018`;e.currentTarget.style.borderColor=`#9c27b040`;e.currentTarget.style.color="#9c27b0"}}
                          onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="transparent";e.currentTarget.style.color=T.textDim}}>
                          <span style={{fontSize:15,width:22,textAlign:"center",color:"#9c27b0",opacity:0.8}}>{block.icon}</span>
                          <div>
                            <div style={{fontSize:11,fontWeight:700,lineHeight:1.2}}>{block.name}</div>
                            <div style={{fontSize:8,color:T.textDim,fontWeight:400,lineHeight:1.2,marginTop:1,opacity:0.7}}>from {baseDef.label}</div>
                          </div>
                        </button>
                        {/* Edit button for imported_gds blocks (layer reassignment) */}
                        {block.params?.all_polygons && (
                          <button onClick={()=>{
                            // Ensure block has an id for editing
                            const blockWithId = block.id ? block : {...block, id: `migrated_${Date.now()}`};
                            if (!block.id) {
                              // Migrate the block to have an id
                              setCustomBlocks(prev => prev.map(b => b === block ? blockWithId : b));
                            }
                            setEditBBModal(blockWithId);
                          }} title="Edit layers"
                            style={{background:"transparent",border:"none",color:T.accent,cursor:"pointer",padding:"4px",fontSize:10,opacity:0.5}}
                            onMouseEnter={e=>{e.currentTarget.style.opacity="1"}}
                            onMouseLeave={e=>{e.currentTarget.style.opacity="0.5"}}>✎</button>
                        )}
                        <button onClick={()=>deleteCustomBlock(block.id)} title="Delete"
                          style={{background:"transparent",border:"none",color:T.error,cursor:"pointer",padding:"4px",fontSize:10,opacity:0.5}}
                          onMouseEnter={e=>{e.currentTarget.style.opacity="1"}}
                          onMouseLeave={e=>{e.currentTarget.style.opacity="0.5"}}>✕</button>
                      </div>
                    );
                  })}
                </div>}
              </div>
            )}
          </div>
          {connections.length>0&&<div style={{padding:"8px 10px",borderTop:`1px solid ${T.border}`,background:darkMode?T.bg:T.bg2}}>
            <div style={{fontSize:11,fontWeight:700,color:T.textBright,fontFamily:T.sans,marginBottom:4}}>🔗 Connections ({connections.length})</div>
            <div style={{display:"flex",flexDirection:"column",gap:1,maxHeight:120,overflowY:"auto"}}>
              {connections.map(cn=>{const lc=cn.layer==="GM1"?T.gm1:T.sin;return<div key={cn.id} onClick={()=>{setSelConn(cn.id);setSelected(null)}}
                style={{fontSize:9,cursor:"pointer",padding:"3px 8px",borderRadius:3,fontFamily:T.font,color:selConn===cn.id?lc:T.textDim,background:selConn===cn.id?`${lc}12`:"transparent",borderLeft:selConn===cn.id?`2px solid ${lc}`:"2px solid transparent",transition:"all .1s",fontWeight:600}}>{cn.fromPin} → {cn.toPin} <span style={{opacity:0.5,fontSize:8}}>{RT[cn.routeType]?.label}</span></div>})}
            </div>
          </div>}
        </div>

        {/* CANVAS / CODE */}
        <div style={{flex:1,position:"relative",overflow:"hidden"}}>
          {!showCode?(
            <div ref={canvasRef} style={{width:"100%",height:"100%",background:T.canvas||T.bg,cursor:isPanning?"grabbing":"default",position:"relative",overflow:"hidden"}}
              onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} tabIndex={0}>
              <Rulers/>
              <svg className="cbg" style={{position:"absolute",left:RSZ,top:RSZ,width:`calc(100% - ${RSZ}px)`,height:`calc(100% - ${RSZ}px)`,pointerEvents:"none"}}>
                <defs>
                  {/* Minor grid - thin dark lines */}
                  <pattern id="gm" width={gSz} height={gSz} patternUnits="userSpaceOnUse" x={pan.x%gSz} y={pan.y%gSz}>
                    <line x1={0} y1={0} x2={gSz} y2={0} stroke={darkMode?"#3d4450":"#b0b8c4"} strokeWidth={0.5} opacity={darkMode?0.4:0.5}/>
                    <line x1={0} y1={0} x2={0} y2={gSz} stroke={darkMode?"#3d4450":"#b0b8c4"} strokeWidth={0.5} opacity={darkMode?0.4:0.5}/>
                  </pattern>
                  {/* Major grid - thicker dark lines every 5 units */}
                  <pattern id="gM" width={gSz*5} height={gSz*5} patternUnits="userSpaceOnUse" x={pan.x%(gSz*5)} y={pan.y%(gSz*5)}>
                    <line x1={0} y1={0} x2={gSz*5} y2={0} stroke={darkMode?"#5a6370":"#7a8694"} strokeWidth={1} opacity={darkMode?0.6:0.7}/>
                    <line x1={0} y1={0} x2={0} y2={gSz*5} stroke={darkMode?"#5a6370":"#7a8694"} strokeWidth={1} opacity={darkMode?0.6:0.7}/>
                  </pattern>
                </defs>
                {gridSnap&&<><rect width="100%" height="100%" fill="url(#gm)"/><rect width="100%" height="100%" fill="url(#gM)"/></>}
              </svg>
              <svg style={{position:"absolute",left:pan.x,top:pan.y,overflow:"visible",pointerEvents:"all",width:1,height:1,zIndex:5,transform:cssZoomRatio!==1?`scale(${cssZoomRatio})`:undefined,transformOrigin:"0 0"}}>
                <LayerPatternDefs/>
                <ConnLines/>
              </svg>
              <div style={{position:"absolute",left:pan.x,top:pan.y,transform:cssZoomRatio!==1?`scale(${cssZoomRatio})`:undefined,transformOrigin:"0 0"}}>
                {placed.map(c=>{
                  const def=DEFS[c.type];
                  if(!def)return null;
                  const isSel=c.id===selected;
                  const isMulti=multiSel.includes(c.id)&&multiSel.length>=2;
                  const isLoading=polygonLoadingIds.has(c.id);
                  
                  let content;
                  const polyData = componentPolygons[c.id];
                  
                  if (polyData && polyData.polygons && polyData.polygons.length > 0) {
                    content = (
                      <RealPolygonRenderer 
                        polygons={polyData.polygons}
                        bbox={polyData.bbox}
                        primaryPin={polyData.primary_pin}
                        pins={polyData.pins}
                        scale={RS}
                        selected={isSel}
                        darkMode={darkMode}
                        rotation={c.rotation || 0}
                        componentType={c.type}
                        highlightLayer={highlightLayer}
                        hiddenLayers={hiddenLayers}
                      />
                    );
                  } else {
                    const estimatedSize = 50;
                    content = (
                      <div style={{
                        width: estimatedSize, height: estimatedSize,
                        background: `${def.color}15`, border: `1px dashed ${def.color}55`,
                        borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
                        marginLeft: -estimatedSize/2, marginTop: -estimatedSize/2
                      }}>
                        <div style={{ color: def.color, fontSize: 8, fontFamily: T.sans, textAlign: "center", opacity: 0.7 }}>
                          {isLoading ? "⏳" : "..."}
                        </div>
                      </div>
                    );
                  }
                  
                  return(
                    <div key={c.id} style={{position:"absolute",left:c.x*RS,top:c.y*RS,
                      cursor:rulerMode?"crosshair":alignMode?"crosshair":dragging===c.id?"grabbing":"grab"}}
                      onMouseDown={e=>startDrag(e,c.id)}
                      onWheel={e=>{}}>
                      {content}
                    </div>
                  );
                })}</div>
              <svg style={{position:"absolute",left:pan.x,top:pan.y,overflow:"visible",pointerEvents:"all",width:1,height:1,zIndex:10,transform:cssZoomRatio!==1?`scale(${cssZoomRatio})`:undefined,transformOrigin:"0 0"}} onMouseDown={e=>{if(e.target!==e.currentTarget)e.stopPropagation()}}><PinDots/></svg>

              {/* Ruler overlay - crosshairs and measurements */}
              {(rulerMode || rulerMarkers.length > 0) && (()=>{
                const els=[];
                const purple="#7b1fa2";
                
                // Draw crosshair at point
                const drawCrosshair=(x, y, key)=>{
                  const px=x*S, py=y*S;
                  const size=12;
                  return <g key={key}>
                    {/* Crosshair lines */}
                    <line x1={px-size} y1={py} x2={px+size} y2={py} stroke={purple} strokeWidth={1.5}/>
                    <line x1={px} y1={py-size} x2={px} y2={py+size} stroke={purple} strokeWidth={1.5}/>
                    {/* Center dot */}
                    <circle cx={px} cy={py} r={2} fill={purple}/>
                    {/* Coordinate label */}
                    <rect x={px+8} y={py-18} width={70} height={14} rx={3} fill="#ffffffe8" stroke={purple} strokeWidth={0.5}/>
                    <text x={px+12} y={py-8} fill={purple} fontSize={9} fontFamily={T.font} fontWeight={600}>
                      {x.toFixed(2)}, {y.toFixed(2)}
                    </text>
                  </g>;
                };
                
                // Draw dimension line between two points
                const drawMeasure=(x1, y1, x2, y2, key)=>{
                  const dxUm=x2-x1, dyUm=y2-y1;
                  const dist=Math.sqrt(dxUm*dxUm+dyUm*dyUm);
                  const apx=x1*S, apy=y1*S, bpx=x2*S, bpy=y2*S;
                  const mpx=(apx+bpx)/2, mpy=(apy+bpy)/2;
                  const ang=Math.atan2(bpy-apy, bpx-apx);
                  const perpX=Math.cos(ang+Math.PI/2)*6, perpY=Math.sin(ang+Math.PI/2)*6;
                  
                  return <g key={key}>
                    {/* Main dimension line */}
                    <line x1={apx} y1={apy} x2={bpx} y2={bpy} stroke={purple} strokeWidth={1.5} opacity={0.8}/>
                    {/* End ticks */}
                    <line x1={apx-perpX} y1={apy-perpY} x2={apx+perpX} y2={apy+perpY} stroke={purple} strokeWidth={2}/>
                    <line x1={bpx-perpX} y1={bpy-perpY} x2={bpx+perpX} y2={bpy+perpY} stroke={purple} strokeWidth={2}/>
                    {/* Distance label */}
                    <rect x={mpx-40} y={mpy-24} width={80} height={20} rx={4} fill="#ffffffe8" stroke={purple} strokeWidth={1}/>
                    <text x={mpx} y={mpy-10} textAnchor="middle" fill={purple} fontSize={11} fontFamily={T.font} fontWeight={700}>{dist.toFixed(2)} µm</text>
                    {/* Δx Δy label */}
                    <rect x={mpx-50} y={mpy} width={100} height={14} rx={3} fill="#ffffffe8" stroke={purple} strokeWidth={0.5}/>
                    <text x={mpx} y={mpy+10} textAnchor="middle" fill={purple} fontSize={8} fontFamily={T.font}>
                      Δx={dxUm.toFixed(2)}  Δy={dyUm.toFixed(2)}
                    </text>
                    {/* Endpoint crosshairs */}
                    <circle cx={apx} cy={apy} r={4} fill="none" stroke={purple} strokeWidth={2}/>
                    <circle cx={apx} cy={apy} r={1.5} fill={purple}/>
                    <circle cx={bpx} cy={bpy} r={4} fill="none" stroke={purple} strokeWidth={2}/>
                    <circle cx={bpx} cy={bpy} r={1.5} fill={purple}/>
                  </g>;
                };
                
                // Draw all saved markers
                rulerMarkers.forEach(m=>{
                  if(m.type==='point'){
                    els.push(drawCrosshair(m.x, m.y, m.id));
                  }else if(m.type==='measure'){
                    els.push(drawMeasure(m.x, m.y, m.x2, m.y2, m.id));
                  }
                });
                
                // Draw live drag measurement
                if(rulerDragging){
                  const dx=Math.abs(rulerDragging.currentX-rulerDragging.startX);
                  const dy=Math.abs(rulerDragging.currentY-rulerDragging.startY);
                  const dist=Math.sqrt(dx*dx+dy*dy);
                  
                  if(dist>0.5){
                    // Show live measurement line
                    els.push(drawMeasure(rulerDragging.startX, rulerDragging.startY, 
                      rulerDragging.currentX, rulerDragging.currentY, 'live'));
                  }else{
                    // Show preview crosshair
                    els.push(drawCrosshair(rulerDragging.startX, rulerDragging.startY, 'preview'));
                  }
                }
                
                // Hint when ruler mode active but no markers
                if(rulerMode && rulerMarkers.length===0 && !rulerDragging){
                  els.push(<text key="hint" x={20} y={20} fill={purple} fontSize={10} fontFamily={T.sans} opacity={0.6}>
                    Click for crosshair · Drag for measurement · Ctrl+K to clear
                  </text>);
                }
                
                // Show marker count and clear hint
                if(rulerMarkers.length>0){
                  els.push(<text key="count" x={20} y={20} fill={purple} fontSize={9} fontFamily={T.sans} opacity={0.5}>
                    {rulerMarkers.length} marker{rulerMarkers.length>1?'s':''} · Ctrl+K to clear
                  </text>);
                }
                
                return <svg style={{position:"absolute",left:pan.x,top:pan.y,overflow:"visible",pointerEvents:"none",width:1,height:1,zIndex:15}}>{els}</svg>;
              })()}

              {/* Floating toolbar above selected component */}
              {selC&&!dragging&&(()=>{
                const bb=getBBox(selC);
                const tx=bb.cx*S+pan.x, ty=bb.yMin*S+pan.y-48;
                const ab={background:T.bg2,border:`1px solid ${T.border}`,color:T.text,minWidth:26,height:26,borderRadius:4,cursor:"pointer",fontSize:10,
                  display:"flex",alignItems:"center",justifyContent:"center",fontFamily:T.sans,padding:"0 4px",fontWeight:600};
                const hover=e=>{e.currentTarget.style.background=darkMode?"#30363d":"#e3edf7";e.currentTarget.style.borderColor=T.accent};
                const out=e=>{e.currentTarget.style.background=T.bg2;e.currentTarget.style.borderColor=T.border};
                const alignOk=alignMode&&multiSel.length>=2;
                const alignBtn=(mode,icon,title)=><button key={mode} onClick={()=>alignComps(mode)} title={title}
                  style={{...ab,opacity:alignOk?1:0.3,cursor:alignOk?"pointer":"default"}} onMouseEnter={alignOk?hover:undefined} onMouseLeave={alignOk?out:undefined}>{icon}</button>;
                return <div style={{position:"absolute",left:tx,top:Math.max(ty,36),transform:"translateX(-50%)",zIndex:20}} onMouseDown={e=>e.stopPropagation()}>
                  <div style={{display:"flex",gap:2,background:darkMode?`${T.bg2}ee`:"#fffd",borderRadius:8,padding:"4px 6px",border:`1px solid ${T.border}`,boxShadow:"0 3px 16px #0003"}}>
                    {alignMode&&<>
                      {alignBtn('left','⫷','Align left edges')}
                      {alignBtn('center-x','⫼','Align centers X')}
                      {alignBtn('right','⫸','Align right edges')}
                      <div style={{width:1,background:T.border,margin:"2px 1px"}}/>
                      {alignBtn('top','⊤','Align top edges')}
                      {alignBtn('center-y','═','Align centers Y')}
                      {alignBtn('bottom','⊥','Align bottom edges')}
                      <div style={{width:1,background:T.border,margin:"2px 1px"}}/>
                      {alignBtn('center','◎','Concentric')}
                      <div style={{width:1,background:T.border,margin:"2px 1px"}}/>
                    </>}
                    <button onClick={copySel} title="Duplicate" style={ab} onMouseEnter={hover} onMouseLeave={out}>⎘</button>
                    <button onClick={delSel} title="Delete" style={{...ab,color:T.error}} onMouseEnter={e=>{e.currentTarget.style.background="#fde8e8"}} onMouseLeave={out}>✕</button>
                  </div>
                  {alignMode&&<div style={{textAlign:"center",fontSize:9,marginTop:3,fontFamily:T.sans,fontWeight:600,
                    color:multiSel.length>=2?T.success:"#e65100"}}>
                    {multiSel.length>=2?`${multiSel.length} selected — click align`:"Click components to select"}
                  </div>}
                </div>;
              })()}
              {placed.length===0&&<div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
                <div style={{width:56,height:56,borderRadius:14,background:`${T.accent}08`,border:`1px solid ${T.accent}11`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:14}}><span style={{fontSize:28,color:`${T.accent}28`}}>◈</span></div>
                <div style={{color:T.textDim,fontSize:12,fontFamily:T.sans,fontWeight:500}}>Add components from the left panel</div>
                <div style={{color:`${T.textDim}66`,fontSize:10,marginTop:5,fontFamily:T.sans}}>Scroll to zoom · Drag to pan · Click pins to connect</div></div>}
              
              {/* Layer Legend Toggle Button */}
              <button 
                onClick={() => setShowLegend(!showLegend)}
                style={{
                  position: "absolute",
                  bottom: 12,
                  right: showLegend ? 160 : 12,
                  background: darkMode ? "rgba(13,17,23,0.92)" : "rgba(255,255,255,0.95)",
                  border: `1px solid ${T.border}`,
                  borderRadius: 6,
                  padding: "5px 8px",
                  fontSize: 9,
                  fontFamily: T.sans,
                  color: T.textDim,
                  cursor: "pointer",
                  zIndex: 26,
                  display: "flex",
                  alignItems: "center",
                  gap: 4
                }}
                title={showLegend ? "Hide layer legend" : "Show layer legend"}
              >
                <span style={{fontSize: 11}}>{showLegend ? "◀" : "▶"}</span>
                {!showLegend && "Layers"}
              </button>

              {/* Layer Legend - bottom right corner */}
              {showLegend && (
                <div style={{
                  position: "absolute",
                  bottom: 12,
                  right: 12,
                  background: darkMode ? "rgba(13,17,23,0.95)" : "rgba(255,255,255,0.98)",
                  border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 9,
                  fontFamily: T.sans,
                  zIndex: 25,
                  maxHeight: 280,
                  overflowY: "auto",
                  boxShadow: "0 2px 12px #0002",
                  minWidth: 160
                }}>
                  <div style={{fontWeight: 700, color: T.textBright, marginBottom: 6, fontSize: 10, borderBottom: `1px solid ${T.border}`, paddingBottom: 4, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                    <span>Layer Legend</span>
                    <div style={{display:"flex",gap:4,alignItems:"center"}}>
                      {hiddenLayers.size > 0 && <button onClick={()=>setHiddenLayers(new Set())} title="Show all layers" style={{background:"transparent",border:"none",color:T.accent,cursor:"pointer",fontSize:7,padding:"1px 3px"}}>Show All</button>}
                      {highlightLayer && <button onClick={()=>setHighlightLayer(null)} style={{background:"transparent",border:"none",color:T.textDim,cursor:"pointer",fontSize:8}}>Clear ✕</button>}
                    </div>
                  </div>
                  {(() => {
                    // Collect all layers currently in the design
                    const usedLayers = new Set();
                    Object.values(componentPolygons).forEach(cp => {
                      if (cp?.polygons) cp.polygons.forEach(p => usedLayers.add(p.layer));
                    });
                    Object.values(connectionPolygons).forEach(cp => {
                      if (cp?.polygons) cp.polygons.forEach(p => usedLayers.add(p.layer));
                    });
                    
                    // If no components, show nothing
                    if (usedLayers.size === 0) {
                      return <div style={{fontSize: 8, color: T.textDim, padding: 4}}>No layers in design</div>;
                    }
                    
                    // Sort layers by layer number
                    const sortedLayers = Array.from(usedLayers).sort((a,b) => a - b);
                    
                    return sortedLayers.map(layerNum => {
                      const layer = String(layerNum);
                      const info = layerColors[layer] || { name: `Layer ${layer}`, color: "#888888", opacity: 0.7 };
                      const isHighlighted = highlightLayer === layerNum;
                      const isHidden = hiddenLayers.has(layerNum);
                      const patterns = ["solid", "hatch", "dots", "diagonal", "cross"];
                      return (
                        <div key={layer} 
                          style={{
                            display: "flex", 
                            alignItems: "center", 
                            gap: 4, 
                            marginBottom: 3, 
                            padding: "3px 4px",
                            borderRadius: 4,
                            background: isHighlighted ? `${info.color}25` : "transparent",
                            border: isHighlighted ? `1px solid ${info.color}` : "1px solid transparent",
                            transition: "all 0.15s",
                            opacity: isHidden ? 0.4 : 1
                          }}
                        >
                          {/* Visibility toggle (eye icon) */}
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              setHiddenLayers(prev => {
                                const newSet = new Set(prev);
                                if (newSet.has(layerNum)) {
                                  newSet.delete(layerNum);
                                } else {
                                  newSet.add(layerNum);
                                }
                                return newSet;
                              });
                            }}
                            title={isHidden ? "Show layer" : "Hide layer"}
                            style={{
                              background: "transparent",
                              border: "none",
                              cursor: "pointer",
                              fontSize: 10,
                              padding: "0 2px",
                              color: isHidden ? T.textDim : info.color,
                              opacity: isHidden ? 0.5 : 0.8
                            }}
                          >
                            {isHidden ? "◯" : "◉"}
                          </button>
                          {/* Layer color swatch - click to highlight */}
                          <div 
                            onClick={() => setHighlightLayer(isHighlighted ? null : layerNum)}
                            style={{
                              width: 14,
                              height: 10,
                              background: info.color,
                              opacity: isHidden ? 0.3 : (isHighlighted ? 1 : info.opacity),
                              borderRadius: 2,
                              border: `1px solid ${info.color}`,
                              flexShrink: 0,
                              boxShadow: isHighlighted ? `0 0 6px ${info.color}` : "none",
                              cursor: "pointer"
                            }}
                          />
                          <span 
                            onClick={() => setHighlightLayer(isHighlighted ? null : layerNum)}
                            style={{color: isHidden ? T.textDim : info.color, fontWeight: 600, minWidth: 22, fontSize: 8, cursor: "pointer"}}
                          >
                            {layer}
                          </span>
                          <span 
                            onClick={() => setHighlightLayer(isHighlighted ? null : layerNum)}
                            style={{color: isHidden ? T.textDim : (isHighlighted ? info.color : T.text), fontSize: 8, flex: 1, cursor: "pointer", textDecoration: isHidden ? "line-through" : "none"}}
                          >
                            {info.name}
                          </span>
                          {/* Pattern selector (on highlight) */}
                          {isHighlighted && !isHidden && (
                            <select 
                              value={info.pattern || "solid"} 
                              onClick={e => e.stopPropagation()}
                              onChange={e => {
                                e.stopPropagation();
                                setLayerColors(prev => ({
                                  ...prev,
                                  [layer]: { ...prev[layer], pattern: e.target.value }
                                }));
                              }}
                              style={{fontSize: 7, padding: "1px 2px", background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 2, color: T.text}}
                            >
                              {patterns.map(p => <option key={p} value={p}>{p}</option>)}
                            </select>
                          )}
                        </div>
                      );
                    });
                  })()}
                  {/* Hide All / Show All buttons */}
                  {(() => {
                    const usedLayers = new Set();
                    Object.values(componentPolygons).forEach(cp => {
                      if (cp?.polygons) cp.polygons.forEach(p => usedLayers.add(p.layer));
                    });
                    Object.values(connectionPolygons).forEach(cp => {
                      if (cp?.polygons) cp.polygons.forEach(p => usedLayers.add(p.layer));
                    });
                    if (usedLayers.size === 0) return null;
                    return (
                      <div style={{display:"flex",gap:4,marginTop:6,paddingTop:6,borderTop:`1px solid ${T.border}`}}>
                        <button 
                          onClick={() => setHiddenLayers(new Set(usedLayers))}
                          style={{flex:1,background:T.bg3,border:`1px solid ${T.border}`,color:T.textDim,padding:"3px 6px",borderRadius:3,cursor:"pointer",fontSize:7}}
                        >
                          Hide All
                        </button>
                        <button 
                          onClick={() => setHiddenLayers(new Set())}
                          style={{flex:1,background:T.bg3,border:`1px solid ${T.border}`,color:T.textDim,padding:"3px 6px",borderRadius:3,cursor:"pointer",fontSize:7}}
                        >
                          Show All
                        </button>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          ):(
            <div style={{width:"100%",height:"100%",display:"flex",flexDirection:"column"}}>
              <div style={{padding:"8px 16px",background:T.bg2,borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:10,color:T.textDim,fontFamily:T.sans}}>{placed.length} components · {connections.length} connections</span><div style={{flex:1}}/>
                <button onClick={()=>navigator.clipboard.writeText(code)} style={btn(false)}>⎘ Copy</button>
                <button onClick={dlPy} style={btn(true)}>↓ .py</button>
              </div>
              <pre style={{flex:1,margin:0,padding:20,background:T.bg,color:T.text,fontSize:11,lineHeight:1.8,overflowY:"auto",fontFamily:T.font,borderLeft:`3px solid ${T.accent}33`}}>{code}</pre>
            </div>)}
        </div>

        {/* RIGHT */}
        <div style={{width:218,background:T.bg2,borderLeft:`1px solid ${T.border}`,display:"flex",flexDirection:"column",padding:12,gap:2,flexShrink:0,overflowY:"auto"}}>
          {selCn&&!selC&&(<>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <div style={{width:3,height:18,borderRadius:2,background:selCn.layer==="GM1"?T.gm1:T.sin}}/>
              <div style={{flex:1}}><div style={{fontSize:11,fontWeight:600,color:T.textBright,fontFamily:T.sans}}>Connection</div><div style={{fontSize:7,color:T.textDim,fontFamily:T.font}}>{selCn.id}</div></div>
              <button onClick={()=>delConn(selCn.id)} title="Delete Connection" style={{background:`${T.error}12`,border:`1px solid ${T.error}33`,color:T.error,padding:"4px 8px",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:T.sans,fontWeight:600}}>✕ Del</button>
            </div>
            <div style={hr}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,fontSize:9}}><div><div style={lbl}>From</div><div style={{...inp,textAlign:"center",fontSize:8,padding:4}}>{selCn.fromPin}</div></div><div><div style={lbl}>To</div><div style={{...inp,textAlign:"center",fontSize:8,padding:4}}>{selCn.toPin}</div></div></div>
            
            {/* Pin Angle Controls */}
            {(()=>{
              // Calculate default angles based on component rotations and pin types
              const fromComp = placed.find(c=>c.id===selCn.fromComp);
              const toComp = placed.find(c=>c.id===selCn.toComp);
              const fromBase = selCn.fromPin.startsWith('a') ? 180 : 0;
              const toBase = selCn.toPin.startsWith('a') ? 180 : 0;
              const fromDefault = (fromBase + (fromComp?.rotation || 0)) % 360;
              const toDefault = (toBase + (toComp?.rotation || 0)) % 360;
              const fromVal = selCn.fromAngle ?? fromDefault;
              const toVal = selCn.toAngle ?? toDefault;
              
              return (<>
                <div style={lbl}>Pin Angles (exit direction °)</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,fontSize:9}}>
                  <div>
                    <div style={{fontSize:7,color:T.textDim,marginBottom:2}}>From: {selCn.fromPin}</div>
                    <div style={{display:"flex",gap:2}}>
                      <input type="number" value={fromVal} step={15} 
                        onChange={e=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,fromAngle:parseFloat(e.target.value)||0}:cn))} 
                        style={{...inp,textAlign:"right",flex:1,fontSize:9}}/>
                      <button onClick={()=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,fromAngle:((cn.fromAngle??fromDefault)+90)%360}:cn))} 
                        style={{...inp,padding:"2px 6px",cursor:"pointer",fontSize:9}}>↻</button>
                    </div>
                  </div>
                  <div>
                    <div style={{fontSize:7,color:T.textDim,marginBottom:2}}>To: {selCn.toPin}</div>
                    <div style={{display:"flex",gap:2}}>
                      <input type="number" value={toVal} step={15} 
                        onChange={e=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,toAngle:parseFloat(e.target.value)||0}:cn))} 
                        style={{...inp,textAlign:"right",flex:1,fontSize:9}}/>
                      <button onClick={()=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,toAngle:((cn.toAngle??toDefault)+90)%360}:cn))} 
                        style={{...inp,padding:"2px 6px",cursor:"pointer",fontSize:9}}>↻</button>
                    </div>
                  </div>
                </div>
                <div style={{display:"flex",gap:4,marginTop:2}}>
                  <button onClick={()=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,fromAngle:((cn.fromAngle??fromDefault)+90)%360,toAngle:((cn.toAngle??toDefault)+90)%360}:cn))} 
                    style={{...inp,flex:1,padding:"4px 6px",cursor:"pointer",fontSize:8,background:`${T.accent}15`,border:`1px solid ${T.accent}33`,color:T.accent}}>↻ Rotate Both +90°</button>
                  <button onClick={()=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,fromAngle:undefined,toAngle:undefined}:cn))} 
                    style={{...inp,flex:1,padding:"4px 6px",cursor:"pointer",fontSize:8}}>Reset (Auto)</button>
                </div>
              </>);
            })()}
            <div style={hr}/>
            
            <div style={lbl}>Layer</div><select value={selCn.layer} onChange={e=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,layer:e.target.value}:cn))} style={{...sel,color:selCn.layer==="GM1"?T.gm1:T.sin}}>{Object.entries(CL).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select>
            <div style={lbl}>Route Type</div><select value={selCn.routeType} onChange={e=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,routeType:e.target.value}:cn))} style={sel}>{Object.entries(RT).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}><div><div style={lbl}>Radius</div><input type="number" value={selCn.radius||100} step={10} onChange={e=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,radius:parseFloat(e.target.value)||100}:cn))} style={{...inp,textAlign:"right"}}/></div>
              <div><div style={lbl}>Width</div><input type="number" value={selCn.width||(selCn.layer==="GM1"?3:.7)} step={.1} onChange={e=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,width:parseFloat(e.target.value)||.7}:cn))} style={{...inp,textAlign:"right"}}/></div></div>
            {selCn.routeType==="taper_p2p"&&<><div style={lbl}>Width 2</div><input type="number" value={selCn.width2||selCn.width||.7} step={.1} onChange={e=>setConnections(p=>p.map(cn=>cn.id===selConn?{...cn,width2:parseFloat(e.target.value)||.7}:cn))} style={{...inp,textAlign:"right"}}/></>}
            <div style={hr}/>
            <button onClick={()=>{
              // Snap this connection: move toComp so its pin aligns with fromComp's pin
              const fromComp = placed.find(c=>c.id===selCn.fromComp);
              const toComp = placed.find(c=>c.id===selCn.toComp);
              if(fromComp && toComp){
                const fromPins = getPins(fromComp, S);
                const toPins = getPins(toComp, S);
                const fromPin = fromPins.find(p=>p.id===selCn.fromPin);
                const toPin = toPins.find(p=>p.id===selCn.toPin);
                if(fromPin && toPin){
                  const dx = fromPin.wx - toPin.wx;
                  const dy = fromPin.wy - toPin.wy;
                  setPlaced(prev=>prev.map(c=>c.id===selCn.toComp?{...c,x:c.x+dx,y:c.y+dy}:c));
                  setExportMsg(`✓ Snapped ${toComp.id} to align pins`);
                  setTimeout(()=>setExportMsg(""),2000);
                }
              }
            }} style={{background:`${T.success}12`,border:`1px solid ${T.success}33`,color:T.success,padding:7,borderRadius:4,cursor:"pointer",fontSize:9,width:"100%",fontFamily:T.sans,fontWeight:600}}>⊕ Snap Pins (Align Components)</button>
          </>)}

          {selC&&selD&&(<>
            {/* Header with quick actions at TOP */}
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <div style={{width:34,height:34,borderRadius:7,background:`${selD.color}14`,border:`1px solid ${selD.color}33`,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:16,color:selD.color}}>{selD.icon}</span></div>
              <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,color:T.textBright,fontFamily:T.sans}}>{selD.label}</div><div style={{fontSize:7,color:T.textDim,fontFamily:T.font}}>{selC.id}</div></div>
            </div>
            
            {/* QUICK ACTIONS - Rotation, Copy, Delete, Save */}
            <div style={{background:darkMode?"#1c2128":"#f6f8fa",borderRadius:6,padding:8,marginBottom:8,border:`1px solid ${T.border}`}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:3,marginBottom:6}}>
                {[0,90,180,270].map(deg=><button key={deg} onClick={()=>setPlaced(p=>p.map(c=>c.id===selC.id?{...c,rotation:deg}:c))} style={{...btn((selC.rotation||0)===deg,selD.color),padding:"4px 2px",textAlign:"center",fontSize:9}}>{deg}°</button>)}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
                <button onClick={copySel} title="Copy (Ctrl+C)" style={{...btn(false),padding:"5px 4px",fontSize:9,textAlign:"center"}}>⎘ Copy</button>
                <button onClick={delSel} title="Delete (Del)" style={{background:`${T.error}08`,border:`1px solid ${T.error}22`,color:T.error,padding:"5px 4px",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:T.sans,fontWeight:600,textAlign:"center"}}>✕ Del</button>
                <button onClick={() => saveAsBuildingBlock(multiSel.length > 1 ? placed.filter(c => multiSel.includes(c.id)) : selC)} title="Save as Building Block" style={{...btn(false,"#9c27b0"),padding:"5px 4px",fontSize:9,textAlign:"center"}}>💾</button>
              </div>
            </div>
            
            {/* Position display */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3,marginBottom:6}}>{[["x",selC.x],["y",selC.y],["rot",(selC.rotation||0)+"°"]].map(([k,v])=><div key={k} style={{...inp,textAlign:"center",fontSize:8,padding:"3px 2px",color:T.textDim}}>{k} {typeof v==="number"?v.toFixed(0):v}</div>)}</div>

            {/* IMPORTED GDS LAYER ANALYSIS */}
            {selC.type === "imported_gds" && selC.params?.all_polygons && (()=>{
              // PDK layer mapping
              const PDK_LAYERS_INFO = {
                119: { name: "SiNWG", desc: "SiN Waveguide", color: "#0000ff" },
                86: { name: "SiWG", desc: "Si Waveguide", color: "#0000ff" },
                88: { name: "SiNGrating", desc: "SiN Grating", color: "#80fffb" },
                87: { name: "SiGrating", desc: "Si Grating", color: "#80fffb" },
                78: { name: "GraphBot", desc: "Graphene Bottom", color: "#ff0000" },
                79: { name: "GraphTop", desc: "Graphene Top", color: "#ff0000" },
                85: { name: "GraphCont", desc: "Graphene Contact", color: "#ddff00" },
                89: { name: "GraphPass", desc: "Passivation", color: "#01ff6b" },
                97: { name: "GraphPAD", desc: "Bond Pad", color: "#ff8000" },
                109: { name: "GM1", desc: "Metal 1", color: "#ffae00" },
                110: { name: "GM1L", desc: "Metal 1 Top", color: "#008050" },
                118: { name: "GraphGate", desc: "Gate", color: "#ff0000" },
                234: { name: "Align", desc: "Alignment", color: "#80fffb" },
              };
              
              // Analyze layers in the imported GDS
              const layerStats = {};
              selC.params.all_polygons.forEach(poly => {
                const layer = poly.layer;
                if (!layerStats[layer]) {
                  layerStats[layer] = { count: 0, polygons: [], bbox: {minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity} };
                }
                layerStats[layer].count++;
                layerStats[layer].polygons.push(poly);
                // Update bbox
                poly.points.forEach(([x, y]) => {
                  layerStats[layer].bbox.minX = Math.min(layerStats[layer].bbox.minX, x);
                  layerStats[layer].bbox.minY = Math.min(layerStats[layer].bbox.minY, y);
                  layerStats[layer].bbox.maxX = Math.max(layerStats[layer].bbox.maxX, x);
                  layerStats[layer].bbox.maxY = Math.max(layerStats[layer].bbox.maxY, y);
                });
              });
              
              // Identify recognized PDK layers vs unknown
              const pdkLayers = Object.keys(layerStats).filter(l => PDK_LAYERS_INFO[parseInt(l)]).map(l => parseInt(l));
              const unknownLayers = Object.keys(layerStats).filter(l => !PDK_LAYERS_INFO[parseInt(l)]).map(l => parseInt(l));
              
              const extractLayers = (layers, name) => {
                // Combine polygons from specified layers
                const allPolys = [];
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                
                layers.forEach(layer => {
                  if (layerStats[layer]) {
                    allPolys.push(...layerStats[layer].polygons);
                    minX = Math.min(minX, layerStats[layer].bbox.minX);
                    minY = Math.min(minY, layerStats[layer].bbox.minY);
                    maxX = Math.max(maxX, layerStats[layer].bbox.maxX);
                    maxY = Math.max(maxY, layerStats[layer].bbox.maxY);
                  }
                });
                
                if (allPolys.length === 0) return;
                
                // Find NARROW waveguide polygons for pin placement
                const narrowThreshold = 2.0;
                const narrowWgs = [];
                allPolys.forEach(poly => {
                  if(poly.layer !== 119) return;
                  let pMinX=Infinity, pMaxX=-Infinity, pMinY=Infinity, pMaxY=-Infinity;
                  poly.points.forEach(([x,y]) => {
                    pMinX = Math.min(pMinX, x);
                    pMaxX = Math.max(pMaxX, x);
                    pMinY = Math.min(pMinY, y);
                    pMaxY = Math.max(pMaxY, y);
                  });
                  const height = pMaxY - pMinY;
                  if(height < narrowThreshold) {
                    narrowWgs.push({minX: pMinX, maxX: pMaxX, minY: pMinY, maxY: pMaxY});
                  }
                });
                
                let leftPinX = minX, leftPinY = (minY + maxY) / 2;
                let rightPinX = maxX, rightPinY = leftPinY;
                
                if(narrowWgs.length > 0) {
                  const leftmost = narrowWgs.reduce((a,b) => a.minX < b.minX ? a : b);
                  const rightmost = narrowWgs.reduce((a,b) => a.maxX > b.maxX ? a : b);
                  leftPinX = leftmost.minX;
                  leftPinY = (leftmost.minY + leftmost.maxY) / 2;
                  rightPinX = rightmost.maxX;
                  rightPinY = (rightmost.minY + rightmost.maxY) / 2;
                }
                
                const newComp = {
                  id: `ext_${name}_${Date.now()}`,
                  type: "imported_gds",
                  x: selC.x,
                  y: selC.y,
                  rotation: 0,
                  params: {
                    imported: true,
                    original_name: name,
                    polygon_count: allPolys.length,
                    all_polygons: allPolys,
                    width: maxX - minX,
                    height: maxY - minY,
                    bbox: { x_min: minX, y_min: minY, x_max: maxX, y_max: maxY }
                  }
                };
                
                setPlaced(prev => [...prev, newComp]);
                setComponentPolygons(prev => ({
                  ...prev,
                  [newComp.id]: {
                    polygons: allPolys,
                    bbox: { x_min: minX, y_min: minY, x_max: maxX, y_max: maxY },
                    pins: {a0: {x: 0, y: 0}, b0: {x: rightPinX - leftPinX, y: rightPinY - leftPinY}},
                    cacheKey: `extracted_${newComp.id}`
                  }
                }));
                return newComp.id;
              };
              
              const saveAsBlock = (layers, name) => {
                const allPolys = [];
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                
                layers.forEach(layer => {
                  if (layerStats[layer]) {
                    allPolys.push(...layerStats[layer].polygons);
                    minX = Math.min(minX, layerStats[layer].bbox.minX);
                    minY = Math.min(minY, layerStats[layer].bbox.minY);
                    maxX = Math.max(maxX, layerStats[layer].bbox.maxX);
                    maxY = Math.max(maxY, layerStats[layer].bbox.maxY);
                  }
                });
                
                if (allPolys.length === 0) return;
                
                const block = {
                  id: `gds_block_${Date.now()}`,
                  name: name,
                  baseType: "imported_gds",
                  icon: "📥",
                  params: {
                    imported: true,
                    original_name: name,
                    polygon_count: allPolys.length,
                    all_polygons: allPolys,
                    width: maxX - minX,
                    height: maxY - minY,
                    bbox: { x_min: minX, y_min: minY, x_max: maxX, y_max: maxY }
                  },
                  created: new Date().toISOString()
                };
                
                setCustomBlocks(prev => [...prev, block]);
                setExportMsg(`✓ Saved "${name}" as building block`);
                setTimeout(() => setExportMsg(""), 2000);
              };
              
              // Group layers by structure type
              const waveguideLayers = pdkLayers.filter(l => [119, 86].includes(l));
              const gratingLayers = pdkLayers.filter(l => [88, 87].includes(l));
              const grapheneLayers = pdkLayers.filter(l => [78, 79, 85, 89, 118].includes(l));
              const metalLayers = pdkLayers.filter(l => [97, 109, 110].includes(l));
              
              return (
                <>
                  <div style={hr}/>
                  <div style={sec}>GDS Layer Analysis</div>
                  <div style={{fontSize:8,color:T.textDim,marginBottom:6}}>
                    {selC.params.polygon_count} polygons · {pdkLayers.length} PDK layers · {unknownLayers.length} other
                  </div>
                  
                  {/* Quick Extract by Structure Type */}
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:8,fontWeight:600,color:T.textBright,marginBottom:4}}>Extract by Structure</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3}}>
                      {waveguideLayers.length > 0 && (
                        <button onClick={() => {
                          const id = extractLayers(waveguideLayers, "Waveguides");
                          if(id) { setSelected(id); setExportMsg(`✓ Extracted waveguides`); setTimeout(()=>setExportMsg(""),2000); }
                        }} style={{...btn(false,"#0000ff"),padding:"4px",fontSize:8,display:"flex",alignItems:"center",gap:4}}>
                          <span style={{width:8,height:8,background:"#0000ff",borderRadius:2}}/>
                          WG ({waveguideLayers.map(l=>layerStats[l].count).reduce((a,b)=>a+b,0)})
                        </button>
                      )}
                      {gratingLayers.length > 0 && (
                        <button onClick={() => {
                          const id = extractLayers(gratingLayers, "Gratings");
                          if(id) { setSelected(id); setExportMsg(`✓ Extracted gratings`); setTimeout(()=>setExportMsg(""),2000); }
                        }} style={{...btn(false,"#80fffb"),padding:"4px",fontSize:8,display:"flex",alignItems:"center",gap:4}}>
                          <span style={{width:8,height:8,background:"#80fffb",borderRadius:2}}/>
                          Grating ({gratingLayers.map(l=>layerStats[l].count).reduce((a,b)=>a+b,0)})
                        </button>
                      )}
                      {grapheneLayers.length > 0 && (
                        <button onClick={() => {
                          const id = extractLayers(grapheneLayers, "Graphene");
                          if(id) { setSelected(id); setExportMsg(`✓ Extracted graphene`); setTimeout(()=>setExportMsg(""),2000); }
                        }} style={{...btn(false,"#ff0000"),padding:"4px",fontSize:8,display:"flex",alignItems:"center",gap:4}}>
                          <span style={{width:8,height:8,background:"#ff0000",borderRadius:2}}/>
                          Graphene ({grapheneLayers.map(l=>layerStats[l].count).reduce((a,b)=>a+b,0)})
                        </button>
                      )}
                      {metalLayers.length > 0 && (
                        <button onClick={() => {
                          const id = extractLayers(metalLayers, "Metal");
                          if(id) { setSelected(id); setExportMsg(`✓ Extracted metal`); setTimeout(()=>setExportMsg(""),2000); }
                        }} style={{...btn(false,"#ffae00"),padding:"4px",fontSize:8,display:"flex",alignItems:"center",gap:4}}>
                          <span style={{width:8,height:8,background:"#ffae00",borderRadius:2}}/>
                          Metal ({metalLayers.map(l=>layerStats[l].count).reduce((a,b)=>a+b,0)})
                        </button>
                      )}
                    </div>
                  </div>
                  
                  {/* PDK Layers Detail */}
                  <div style={{fontSize:8,fontWeight:600,color:T.textBright,marginBottom:4}}>PDK Layers</div>
                  <div style={{maxHeight:150,overflowY:"auto",border:`1px solid ${T.border}`,borderRadius:4,background:T.bg3,marginBottom:6}}>
                    {pdkLayers.length === 0 ? (
                      <div style={{padding:8,fontSize:8,color:T.textDim,textAlign:"center"}}>No recognized PDK layers</div>
                    ) : pdkLayers.sort((a,b) => layerStats[b].count - layerStats[a].count).map(layer => {
                      const info = PDK_LAYERS_INFO[layer];
                      const stats = layerStats[layer];
                      const w = (stats.bbox.maxX - stats.bbox.minX).toFixed(1);
                      const h = (stats.bbox.maxY - stats.bbox.minY).toFixed(1);
                      return (
                        <div key={layer} style={{padding:"5px 8px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:6}}>
                          <div style={{width:10,height:10,borderRadius:2,background:info.color,flexShrink:0}}/>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:9,fontWeight:600,color:T.textBright}}>{info.name}</div>
                            <div style={{fontSize:7,color:T.textDim}}>{stats.count} poly · {w}×{h} µm</div>
                          </div>
                          <div style={{display:"flex",gap:2}}>
                            {/* Reassign layer dropdown */}
                            <select 
                              value={layer}
                              onChange={(e) => {
                                const newLayer = parseInt(e.target.value);
                                if (newLayer === layer) return;
                                
                                // Reassign all polygons from this layer to the new layer
                                const newPolygons = selC.params.all_polygons.map(poly => 
                                  poly.layer === layer ? {...poly, layer: newLayer} : poly
                                );
                                
                                // Update placed components
                                setPlaced(prev => prev.map(c => c.id === selC.id ? {
                                  ...c, 
                                  params: {...c.params, all_polygons: newPolygons}
                                } : c));
                                
                                // Update componentPolygons with new unique cache key to force re-render
                                setComponentPolygons(prev => ({
                                  ...prev,
                                  [selC.id]: {
                                    ...prev[selC.id],
                                    polygons: newPolygons,
                                    cacheKey: `reassigned_${layer}_to_${newLayer}_${Date.now()}`
                                  }
                                }));
                                
                                // Ensure new layer has a color entry in layerColors
                                const newLayerInfo = PDK_LAYERS_INFO[newLayer];
                                if (newLayerInfo && !layerColors[newLayer]) {
                                  setLayerColors(prev => ({
                                    ...prev,
                                    [newLayer]: { 
                                      name: newLayerInfo.name, 
                                      color: newLayerInfo.color, 
                                      opacity: 0.75, 
                                      pattern: "solid" 
                                    }
                                  }));
                                }
                                
                                setExportMsg(`✓ Reassigned layer ${layer} → ${newLayer}`);
                                setTimeout(()=>setExportMsg(""),2000);
                              }}
                              title="Reassign to different layer"
                              style={{background:T.bg,border:`1px solid ${T.border}`,color:T.textBright,padding:"1px 2px",borderRadius:3,cursor:"pointer",fontSize:7,width:45}}
                            >
                              {Object.entries(PDK_LAYERS_INFO).map(([l, i]) => (
                                <option key={l} value={l}>{i.name}</option>
                              ))}
                            </select>
                            <button onClick={() => {
                              const id = extractLayers([layer], info.name);
                              if(id) setSelected(id);
                            }} title="Extract" style={{background:`${T.accent}15`,border:`1px solid ${T.accent}33`,color:T.accent,padding:"2px 4px",borderRadius:3,cursor:"pointer",fontSize:7}}>⊕</button>
                            <button onClick={() => saveAsBlock([layer], `${selC.params.original_name||"GDS"}_${info.name}`)} title="Save as block" style={{background:"#9c27b015",border:"1px solid #9c27b033",color:"#9c27b0",padding:"2px 4px",borderRadius:3,cursor:"pointer",fontSize:7}}>💾</button>
                            {/* Delete layer button */}
                            <button onClick={() => {
                              // Remove all polygons of this layer
                              const newPolygons = selC.params.all_polygons.filter(poly => poly.layer !== layer);
                              if (newPolygons.length === 0) {
                                // If no polygons left, delete the component
                                setPlaced(prev => prev.filter(c => c.id !== selC.id));
                                setComponentPolygons(prev => {
                                  const {[selC.id]: _, ...rest} = prev;
                                  return rest;
                                });
                                setSelected(null);
                                setExportMsg(`✓ Deleted component (no layers remaining)`);
                              } else {
                                setPlaced(prev => prev.map(c => c.id === selC.id ? {
                                  ...c, 
                                  params: {...c.params, all_polygons: newPolygons, polygon_count: newPolygons.length}
                                } : c));
                                setComponentPolygons(prev => ({
                                  ...prev,
                                  [selC.id]: {
                                    ...prev[selC.id],
                                    polygons: newPolygons,
                                    cacheKey: `edited_${Date.now()}`
                                  }
                                }));
                                setExportMsg(`✓ Removed layer ${info.name}`);
                              }
                              setTimeout(()=>setExportMsg(""),2000);
                            }} title="Delete this layer" style={{background:`${T.error}15`,border:`1px solid ${T.error}33`,color:T.error,padding:"2px 4px",borderRadius:3,cursor:"pointer",fontSize:7}}>✕</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  
                  {/* Save Complete Structure */}
                  <div style={{display:"flex",gap:3}}>
                    <button onClick={() => saveAsBlock(pdkLayers, `${selC.params.original_name||"GDS"}_Complete`)} 
                      style={{...btn(false,"#9c27b0"),flex:1,padding:"5px",fontSize:8}}>
                      💾 Save All PDK Layers
                    </button>
                    <button onClick={() => {
                      // Delete this imported component after extraction
                      setPlaced(prev => prev.filter(c => c.id !== selC.id));
                      setSelected(null);
                    }} style={{...btn(false,T.error),padding:"5px 8px",fontSize:8}}>✕</button>
                  </div>
                </>
              );
            })()}

            {/* Multi-select alignment toolbar */}
            {multiSel.length>=2&&(<>
              <div style={hr}/>
              <div style={sec}>Align ({multiSel.length} selected)</div>
              <div style={{fontSize:8,color:T.textDim,marginBottom:4,fontFamily:T.sans}}>Shift+click to add. First selected = reference.</div>
              
              {/* Bounding Box Alignment */}
              <div style={{fontSize:8,fontWeight:600,color:T.textBright,marginBottom:3}}>Bounding Box</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:3,marginBottom:3}}>
                <button onClick={()=>alignComps('left')} title="Align left edges" style={{...btn(false),padding:"4px 2px",fontSize:9,textAlign:"center"}}>⫷ L</button>
                <button onClick={()=>alignComps('center-x')} title="Align centers horizontally" style={{...btn(false),padding:"4px 2px",fontSize:9,textAlign:"center"}}>⫼ CX</button>
                <button onClick={()=>alignComps('right')} title="Align right edges" style={{...btn(false),padding:"4px 2px",fontSize:9,textAlign:"center"}}>⫸ R</button>
                <button onClick={()=>alignComps('center')} title="Concentric (center both)" style={{...btn(false,T.warn),padding:"4px 2px",fontSize:9,textAlign:"center"}}>◎</button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:3,marginBottom:6}}>
                <button onClick={()=>alignComps('top')} title="Align top edges" style={{...btn(false),padding:"4px 2px",fontSize:9,textAlign:"center"}}>⫠ T</button>
                <button onClick={()=>alignComps('center-y')} title="Align centers vertically" style={{...btn(false),padding:"4px 2px",fontSize:9,textAlign:"center"}}>⫾ CY</button>
                <button onClick={()=>alignComps('bottom')} title="Align bottom edges" style={{...btn(false),padding:"4px 2px",fontSize:9,textAlign:"center"}}>⫡ B</button>
                <button onClick={()=>alignComps('outer-match')} title="Match outer surfaces" style={{...btn(false,T.warn),padding:"4px 2px",fontSize:9,textAlign:"center"}}>⊙</button>
              </div>
              
              {/* Pin Alignment */}
              <div style={{fontSize:8,fontWeight:600,color:T.accent,marginBottom:3}}>Pin Alignment (b0 → a0)</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3,marginBottom:4}}>
                <button onClick={()=>alignComps('pin-match-x')} title="Match pin X positions" style={{...btn(false,T.accent),padding:"4px 2px",fontSize:8,textAlign:"center"}}>Match X</button>
                <button onClick={()=>alignComps('pin-match-y')} title="Match pin Y positions" style={{...btn(false,T.accent),padding:"4px 2px",fontSize:8,textAlign:"center"}}>Match Y</button>
                <button onClick={()=>alignComps('pin-match-xy')} title="Pins touch (match X+Y)" style={{...btn(false,T.accent),padding:"4px 2px",fontSize:8,textAlign:"center"}}>Touch</button>
              </div>
              
              {/* Pin Offset Controls */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:4}}>
                <div>
                  <div style={{fontSize:7,color:T.textDim,marginBottom:2}}>X Offset (µm)</div>
                  <div style={{display:"flex",gap:2}}>
                    <input type="number" value={pinOffsetX} step={1} 
                      onChange={e=>setPinOffsetX(parseFloat(e.target.value)||0)}
                      style={{...inp,flex:1,fontSize:9,padding:"3px 4px",textAlign:"right"}}/>
                    <button onClick={()=>alignComps('pin-offset-x',pinOffsetX,0)} 
                      title={`Place pins ${pinOffsetX}µm apart in X`}
                      style={{...btn(false,T.accent),padding:"3px 6px",fontSize:8}}>→</button>
                  </div>
                </div>
                <div>
                  <div style={{fontSize:7,color:T.textDim,marginBottom:2}}>Y Offset (µm)</div>
                  <div style={{display:"flex",gap:2}}>
                    <input type="number" value={pinOffsetY} step={1}
                      onChange={e=>setPinOffsetY(parseFloat(e.target.value)||0)}
                      style={{...inp,flex:1,fontSize:9,padding:"3px 4px",textAlign:"right"}}/>
                    <button onClick={()=>alignComps('pin-offset-y',0,pinOffsetY)} 
                      title={`Place pins ${pinOffsetY}µm apart in Y`}
                      style={{...btn(false,T.accent),padding:"3px 6px",fontSize:8}}>↓</button>
                  </div>
                </div>
              </div>
            </>)}
            
            <div style={hr}/>
            
            {/* Parameters */}
            {(selD.paramGroups||[{label:"Parameters",keys:Object.keys(selC.params)}]).map(g=>(
              <div key={g.label}><div style={sec}>{g.label}</div>
                {g.keys.map(k=><div key={k} style={{marginBottom:3}}><div style={lbl}>{selD.paramLabels?.[k]||k}</div>
                  {k==="layer"||k==="lattice"||k==="element_shape"||k==="inner_style"?<select value={selC.params[k]||(k==="layer"?"SiNWG":k==="lattice"?"square":k==="inner_style"?"arc":"rectangle")} onChange={e=>updateParam(k,e.target.value)} onMouseDown={e=>e.stopPropagation()} style={{...sel,color:k==="layer"?(PDK_LAYERS[selC.params[k]]?.color||T.accent):T.text,fontWeight:600}}>
                    {k==="layer"?Object.entries(PDK_LAYERS).map(([k2,v])=><option key={k2} value={k2} style={{color:v.color,fontWeight:600}}>{v.label} ({v.num})</option>)
                    :k==="lattice"?["square","hexagonal"].map(v=><option key={v} value={v}>{v}</option>)
                    :k==="inner_style"?["arc","flat"].map(v=><option key={v} value={v}>{v}</option>)
                    :["rectangle","circle"].map(v=><option key={v} value={v}>{v}</option>)}</select>
                  :k==="rotate_elements"?<label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}>
                    <input type="checkbox" checked={selC.params[k]!==false} onChange={e=>updateParam(k,e.target.checked)} style={{width:14,height:14,cursor:"pointer"}}/>
                    <span style={{fontSize:10,color:T.text}}>{selC.params[k]!==false?"Yes":"No"}</span>
                  </label>
                  :k==="image_url"?<div style={{display:"flex",flexDirection:"column",gap:4}}>
                    <input type="file" accept="image/*" onChange={e=>{
                      const file=e.target.files?.[0];
                      if(file){
                        const reader=new FileReader();
                        reader.onload=ev=>{updateParam("image_url",ev.target.result)};
                        reader.readAsDataURL(file);
                      }
                    }} style={{fontSize:9,color:T.text}}/>
                    {selC.params.image_url&&<div style={{position:"relative"}}>
                      <img src={selC.params.image_url} alt="preview" style={{width:"100%",maxHeight:80,objectFit:"contain",borderRadius:4,border:`1px solid ${T.border}`}}/>
                      <button onClick={()=>updateParam("image_url","")} style={{position:"absolute",top:2,right:2,background:T.bg2,border:`1px solid ${T.border}`,color:T.text,borderRadius:3,padding:"1px 4px",fontSize:8,cursor:"pointer"}}>✕</button>
                    </div>}
                    <input type="text" placeholder="or paste URL..." value={selC.params[k]?.startsWith?.("data:")?"":(selC.params[k]||"")} onChange={e=>updateParam(k,e.target.value)} onMouseDown={e=>e.stopPropagation()} style={{...inp,textAlign:"left",fontSize:8}}/>
                  </div>
                  :typeof selC.params[k]==="string"&&k!=="layer"?
                    <input type="text" value={selC.params[k]} onChange={e=>updateParam(k,e.target.value)} onMouseDown={e=>e.stopPropagation()} style={{...inp,textAlign:"left"}}/>
                  :<input type="number" value={selC.params[k]} step={["width","gap","period","overlap","ff","size","spacing","ratio","offset","shrink"].some(s=>k.toLowerCase().includes(s))?.01:1} onChange={e=>updateParam(k,e.target.value)} onMouseDown={e=>e.stopPropagation()} style={{...inp,textAlign:"right"}}/>}
                </div>)}</div>))}
            <div style={hr}/>
            <div style={sec}>Pins</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:3}}>{getPins(selC,S).map(pin=>{const pc=pin.layer==="GM1"?T.gm1:T.sin;return<div key={pin.id} style={{fontSize:8,color:pc,padding:"2px 7px",background:`${pc}10`,borderRadius:10,fontFamily:T.font,border:`1px solid ${pc}22`}}>{pin.id}</div>})}</div>
          </>)}

          {!selC&&!selCn&&<div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:6}}>
            <div style={{width:36,height:36,borderRadius:8,background:T.bg3,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:16,color:T.textDim}}>⚙</span></div>
            <div style={{color:T.textDim,fontSize:10,textAlign:"center",lineHeight:1.7,fontFamily:T.sans}}>Select a component<br/>or connection to edit</div></div>}
        </div>
      </div>

      {/* PREVIEW MODAL */}
      {previewImg&&<div style={{position:"fixed",inset:0,background:"#000000aa",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)"}}
        onClick={()=>setPreviewImg(null)}>
        <div style={{background:T.bg2,borderRadius:12,padding:16,maxWidth:"90vw",maxHeight:"90vh",overflow:"auto",boxShadow:"0 8px 40px #0004"}}
          onClick={e=>e.stopPropagation()}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:T.textBright,fontFamily:T.sans}}>GDS Preview (Matplotlib)</div>
              <div style={{fontSize:10,color:T.textDim,fontFamily:T.sans}}>Actual nazca render — what KLayout will show</div>
            </div>
            <div style={{display:"flex",gap:6}}>
              <button onClick={()=>{const a=document.createElement("a");a.href=`data:image/png;base64,${previewImg}`;a.download="gds_preview.png";a.click()}}
                style={{...btn(false),padding:"5px 12px",fontSize:10}}>↓ Save PNG</button>
              <button onClick={()=>setPreviewImg(null)} style={{...btn(false,T.error),padding:"5px 12px",fontSize:10}}>✕ Close</button>
            </div>
          </div>
          <img src={`data:image/png;base64,${previewImg}`} alt="GDS Preview"
            style={{maxWidth:"85vw",maxHeight:"78vh",borderRadius:6,border:"1px solid #ddd"}}/>
        </div>
      </div>}

      {/* SESSION DIALOG MODAL */}
      {modalState&&<div style={{position:"fixed",inset:0,background:"#000000aa",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)"}}
        onClick={()=>setModalState(null)}>
        <div style={{background:T.bg2,borderRadius:12,padding:20,minWidth:300,boxShadow:"0 8px 40px #0004"}}
          onClick={e=>e.stopPropagation()}>
          {modalState.type==='delete'?(
            <>
              <div style={{fontSize:14,fontWeight:700,color:T.textBright,fontFamily:T.sans,marginBottom:12}}>Delete Session?</div>
              <div style={{fontSize:11,color:T.textDim,fontFamily:T.sans,marginBottom:16}}>This will permanently delete "{sessionsData.sessions.find(s=>s.id===modalState.id)?.name}". This action cannot be undone.</div>
              <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                <button onClick={()=>setModalState(null)} style={{...btn(false),padding:"8px 16px",fontSize:11}}>Cancel</button>
                <button onClick={()=>doDeleteSession(modalState.id)} style={{background:T.error,border:`1px solid ${T.error}`,color:"#fff",padding:"8px 16px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:T.sans}}>Delete</button>
              </div>
            </>
          ):(
            <>
              <div style={{fontSize:14,fontWeight:700,color:T.textBright,fontFamily:T.sans,marginBottom:12}}>
                {modalState.type==='new'?'New Session':'Rename Session'}
              </div>
              <input 
                ref={modalInputRef}
                type="text" 
                defaultValue={modalState.value||''} 
                placeholder="Session name..."
                autoFocus
                onKeyDown={e=>{
                  if(e.key==='Enter'){
                    const val=e.target.value.trim();
                    if(modalState.type==='new') doNewSession(val);
                    else doRenameSession(modalState.id, val);
                  }
                  if(e.key==='Escape') setModalState(null);
                }}
                style={{...inp,marginBottom:16,fontSize:12,padding:"10px 12px"}}
              />
              <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                <button onClick={()=>setModalState(null)} style={{...btn(false),padding:"8px 16px",fontSize:11}}>Cancel</button>
                <button onClick={()=>{
                  const val=modalInputRef.current?.value?.trim();
                  if(modalState.type==='new') doNewSession(val);
                  else doRenameSession(modalState.id, val);
                }} style={{background:T.accent,border:`1px solid ${T.accent}`,color:"#fff",padding:"8px 16px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:T.sans}}>
                  {modalState.type==='new'?'Create':'Rename'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>}

      {/* SAVE BUILDING BLOCK MODAL */}
      {saveBBModal && (
        <div style={{position:"fixed",inset:0,background:"#000000aa",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)"}}
          onClick={()=>setSaveBBModal(null)}>
          <div style={{background:T.bg2,borderRadius:12,padding:20,minWidth:340,boxShadow:"0 8px 40px #0004"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:14,fontWeight:700,color:T.textBright,fontFamily:T.sans,marginBottom:8,display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:18}}>💾</span>
              Save as Building Block
            </div>
            <div style={{fontSize:10,color:T.textDim,fontFamily:T.sans,marginBottom:16}}>
              {saveBBModal.comps.length === 1 
                ? `Save "${DEFS[saveBBModal.comps[0].type]?.label || 'Component'}" with current parameters`
                : `Save ${saveBBModal.comps.length} components as a group`}
            </div>
            <div style={{marginBottom:16}}>
              <div style={{fontSize:9,fontWeight:600,color:T.textDim,marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Name</div>
              <input 
                type="text" 
                value={saveBBName}
                onChange={e => setSaveBBName(e.target.value)}
                placeholder="Enter block name..."
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && saveBBName.trim()) confirmSaveBB();
                  if (e.key === 'Escape') setSaveBBModal(null);
                }}
                style={{...inp,fontSize:12,padding:"10px 12px",width:"100%",boxSizing:"border-box"}}
              />
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
              <button onClick={()=>setSaveBBModal(null)} style={{...btn(false),padding:"8px 16px",fontSize:11}}>Cancel</button>
              <button 
                onClick={confirmSaveBB} 
                disabled={!saveBBName.trim()}
                style={{
                  background: saveBBName.trim() ? "#9c27b0" : T.bg3,
                  border: `1px solid ${saveBBName.trim() ? "#9c27b0" : T.border}`,
                  color: saveBBName.trim() ? "#fff" : T.textDim,
                  padding:"8px 16px",
                  borderRadius:5,
                  cursor: saveBBName.trim() ? "pointer" : "not-allowed",
                  fontSize:11,
                  fontWeight:600,
                  fontFamily:T.sans
                }}>
                💾 Save Block
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT BUILDING BLOCK MODAL - Layer Reassignment */}
      {editBBModal && editBBModal.params?.all_polygons && (() => {
        const PDK_LAYERS_INFO = {
          119: { name: "SiNWG", desc: "SiN Waveguide", color: "#0000ff" },
          86: { name: "SiWG", desc: "Si Waveguide", color: "#0000ff" },
          88: { name: "SiNGrating", desc: "SiN Grating", color: "#80fffb" },
          87: { name: "SiGrating", desc: "Si Grating", color: "#80fffb" },
          78: { name: "GraphBot", desc: "Graphene Bottom", color: "#ff0000" },
          79: { name: "GraphTop", desc: "Graphene Top", color: "#ff0000" },
          85: { name: "GraphCont", desc: "Graphene Contact", color: "#ddff00" },
          89: { name: "GraphPass", desc: "Passivation", color: "#01ff6b" },
          97: { name: "GraphPAD", desc: "Bond Pad", color: "#ff8000" },
          109: { name: "GM1", desc: "Metal 1", color: "#ffae00" },
          110: { name: "GM1L", desc: "Metal 1 Top", color: "#008050" },
          118: { name: "GraphGate", desc: "Gate", color: "#ff0000" },
          234: { name: "Align", desc: "Alignment", color: "#80fffb" },
        };
        
        // Analyze layers
        const layerStats = {};
        editBBModal.params.all_polygons.forEach(poly => {
          const layer = poly.layer;
          if (!layerStats[layer]) layerStats[layer] = { count: 0 };
          layerStats[layer].count++;
        });
        
        const layers = Object.keys(layerStats).map(l => parseInt(l)).sort((a,b) => layerStats[b].count - layerStats[a].count);
        
        const reassignLayer = (fromLayer, toLayer) => {
          if (fromLayer === toLayer) return;
          const newPolygons = editBBModal.params.all_polygons.map(poly =>
            poly.layer === fromLayer ? {...poly, layer: toLayer} : poly
          );
          // Update the block in customBlocks
          setCustomBlocks(prev => prev.map(b => 
            b.id === editBBModal.id ? {
              ...b,
              params: {...b.params, all_polygons: newPolygons}
            } : b
          ));
          // Update the modal state to reflect changes
          setEditBBModal(prev => ({
            ...prev,
            params: {...prev.params, all_polygons: newPolygons}
          }));
          setExportMsg(`✓ Reassigned layer ${fromLayer} → ${toLayer} in block`);
          setTimeout(()=>setExportMsg(""),2000);
        };
        
        const deleteLayer = (layer) => {
          const newPolygons = editBBModal.params.all_polygons.filter(poly => poly.layer !== layer);
          if (newPolygons.length === 0) {
            // Delete the entire block
            setCustomBlocks(prev => prev.filter(b => b.id !== editBBModal.id));
            setEditBBModal(null);
            setExportMsg(`✓ Deleted block (no layers remaining)`);
          } else {
            setCustomBlocks(prev => prev.map(b =>
              b.id === editBBModal.id ? {
                ...b,
                params: {...b.params, all_polygons: newPolygons, polygon_count: newPolygons.length}
              } : b
            ));
            setEditBBModal(prev => ({
              ...prev,
              params: {...prev.params, all_polygons: newPolygons, polygon_count: newPolygons.length}
            }));
            setExportMsg(`✓ Removed layer from block`);
          }
          setTimeout(()=>setExportMsg(""),2000);
        };
        
        return (
          <div style={{position:"fixed",inset:0,background:"#000000aa",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)"}}
            onClick={()=>setEditBBModal(null)}>
            <div style={{background:T.bg2,borderRadius:12,padding:20,minWidth:380,maxWidth:500,boxShadow:"0 8px 40px #0004"}}
              onClick={e=>e.stopPropagation()}>
              <div style={{fontSize:14,fontWeight:700,color:T.textBright,fontFamily:T.sans,marginBottom:8,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:18}}>✎</span>
                Edit Building Block Layers
              </div>
              <div style={{fontSize:10,color:T.textDim,fontFamily:T.sans,marginBottom:16}}>
                "{editBBModal.name}" — {editBBModal.params.polygon_count} polygons · {layers.length} layers
              </div>
              
              <div style={{maxHeight:300,overflowY:"auto",border:`1px solid ${T.border}`,borderRadius:6,background:T.bg3}}>
                {layers.map(layer => {
                  const info = PDK_LAYERS_INFO[layer] || { name: `Layer ${layer}`, color: "#888888" };
                  const count = layerStats[layer].count;
                  return (
                    <div key={layer} style={{padding:"8px 12px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:12,height:12,borderRadius:3,background:info.color,flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:10,fontWeight:600,color:T.textBright}}>{info.name}</div>
                        <div style={{fontSize:8,color:T.textDim}}>{count} polygons · Layer {layer}</div>
                      </div>
                      <select 
                        value={layer}
                        onChange={(e) => reassignLayer(layer, parseInt(e.target.value))}
                        title="Reassign to different layer"
                        style={{background:T.bg,border:`1px solid ${T.border}`,color:T.textBright,padding:"3px 6px",borderRadius:4,cursor:"pointer",fontSize:9,minWidth:70}}
                      >
                        {Object.entries(PDK_LAYERS_INFO).map(([l, i]) => (
                          <option key={l} value={l}>{i.name}</option>
                        ))}
                      </select>
                      <button 
                        onClick={() => deleteLayer(layer)} 
                        title="Remove this layer"
                        style={{background:`${T.error}15`,border:`1px solid ${T.error}33`,color:T.error,padding:"4px 8px",borderRadius:4,cursor:"pointer",fontSize:9}}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
              
              <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
                <button onClick={()=>setEditBBModal(null)} style={{background:T.accent,border:`1px solid ${T.accent}`,color:"#fff",padding:"8px 16px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:T.sans}}>
                  Done
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* PDK MANAGER MODAL */}
      {showPdkManager && (
        <div style={{position:"fixed",inset:0,background:"#000a",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>{setShowPdkManager(false);setEditingPdk(null)}}>
          <div style={{background:T.bg,borderRadius:10,padding:24,width:700,maxHeight:"85vh",overflowY:"auto",boxShadow:"0 10px 40px #0008"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <h2 style={{margin:0,fontSize:18,fontWeight:700,color:T.textBright,fontFamily:T.sans}}>
                {editingPdk ? "Edit PDK" : "PDK Manager"}
              </h2>
              <button onClick={()=>{setShowPdkManager(false);setEditingPdk(null)}} style={{background:"transparent",border:"none",color:T.textDim,cursor:"pointer",fontSize:18}}>✕</button>
            </div>
            
            {!editingPdk ? (
              <>
                {/* PDK List View */}
                <div style={{marginBottom:16,padding:12,background:T.bg2,borderRadius:8}}>
                  <div style={{fontSize:10,color:T.textDim,marginBottom:8,fontFamily:T.sans}}>
                    Active PDK: <strong style={{color:T.accent}}>{pdkData?.name || "IHP SiN Photonics"}</strong>
                  </div>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:T.sans}}>
                    PDKs define layers, colors, design rules, and waveguide parameters for your foundry process.
                  </div>
                </div>
                
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:11,fontWeight:600,color:T.textBright,marginBottom:8,fontFamily:T.sans}}>Available PDKs</div>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {pdkList.map(pdk => (
                      <div key={pdk.id} style={{display:"flex",alignItems:"center",gap:8,padding:10,background:activePdk===pdk.id?`${T.accent}22`:T.bg2,borderRadius:6,border:`1px solid ${activePdk===pdk.id?T.accent:T.border}`}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:11,fontWeight:600,color:T.textBright,fontFamily:T.sans}}>{pdk.name}</div>
                          <div style={{fontSize:9,color:T.textDim,fontFamily:T.sans}}>v{pdk.version} {pdk.builtin && "(Built-in)"}</div>
                        </div>
                        <button onClick={()=>loadPdk(pdk.id)} style={{background:T.accent,border:"none",color:"#fff",padding:"4px 10px",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:T.sans}}>
                          {activePdk===pdk.id?"✓ Active":"Use"}
                        </button>
                        <button onClick={()=>exportPdk(pdk.id)} style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,padding:"4px 8px",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:T.sans}}>
                          Export
                        </button>
                        {!pdk.builtin && (
                          <button onClick={()=>deletePdk(pdk.id)} style={{background:"#d32f2f",border:"none",color:"#fff",padding:"4px 8px",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:T.sans}}>
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                
                <div style={{borderTop:`1px solid ${T.border}`,paddingTop:16,marginBottom:16}}>
                  <div style={{fontSize:11,fontWeight:600,color:T.textBright,marginBottom:8,fontFamily:T.sans}}>Create or Import PDK</div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={getPdkTemplate} style={{background:"#00695c",border:"none",color:"#fff",padding:"8px 16px",borderRadius:4,cursor:"pointer",fontSize:10,fontWeight:600,fontFamily:T.sans}}>
                      + New PDK
                    </button>
                    <label style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,padding:"8px 16px",borderRadius:4,cursor:"pointer",fontSize:10,fontWeight:600,fontFamily:T.sans}}>
                      Import JSON
                      <input type="file" accept=".json" style={{display:"none"}} onChange={e=>{if(e.target.files[0])importPdk(e.target.files[0])}}/>
                    </label>
                  </div>
                </div>
                
                {/* Quick Guide */}
                <div style={{background:`${T.accent}11`,border:`1px solid ${T.accent}33`,borderRadius:8,padding:12}}>
                  <div style={{fontSize:11,fontWeight:600,color:T.accent,marginBottom:8,fontFamily:T.sans}}>📘 How to Create a Custom PDK</div>
                  <ol style={{margin:0,paddingLeft:20,fontSize:10,color:T.text,lineHeight:1.6,fontFamily:T.sans}}>
                    <li><strong>Click "+ New PDK"</strong> to get a template</li>
                    <li><strong>Set basic info:</strong> name, version, description</li>
                    <li><strong>Define layers:</strong> GDS layer number, name, color, pattern</li>
                    <li><strong>Add design rules:</strong> min width, min space, min area per layer</li>
                    <li><strong>Configure waveguides:</strong> default width, min bend radius</li>
                    <li><strong>Save</strong> and switch to your new PDK</li>
                  </ol>
                </div>
              </>
            ) : (
              <>
                {/* PDK Editor View */}
                <div style={{marginBottom:12}}>
                  <label style={{fontSize:10,color:T.textDim,display:"block",marginBottom:4,fontFamily:T.sans}}>PDK Name *</label>
                  <input type="text" value={editingPdk.name||""} onChange={e=>setEditingPdk({...editingPdk,name:e.target.value})}
                    style={{width:"100%",padding:"8px 10px",background:T.bg2,border:`1px solid ${T.border}`,borderRadius:4,color:T.text,fontSize:12,fontFamily:T.sans}}/>
                </div>
                
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                  <div>
                    <label style={{fontSize:10,color:T.textDim,display:"block",marginBottom:4,fontFamily:T.sans}}>Version</label>
                    <input type="text" value={editingPdk.version||"1.0"} onChange={e=>setEditingPdk({...editingPdk,version:e.target.value})}
                      style={{width:"100%",padding:"8px 10px",background:T.bg2,border:`1px solid ${T.border}`,borderRadius:4,color:T.text,fontSize:11,fontFamily:T.sans}}/>
                  </div>
                  <div>
                    <label style={{fontSize:10,color:T.textDim,display:"block",marginBottom:4,fontFamily:T.sans}}>Units</label>
                    <select value={editingPdk.units||"um"} onChange={e=>setEditingPdk({...editingPdk,units:e.target.value})}
                      style={{width:"100%",padding:"8px 10px",background:T.bg2,border:`1px solid ${T.border}`,borderRadius:4,color:T.text,fontSize:11,fontFamily:T.sans}}>
                      <option value="um">Micrometers (µm)</option>
                      <option value="nm">Nanometers (nm)</option>
                    </select>
                  </div>
                </div>
                
                <div style={{marginBottom:12}}>
                  <label style={{fontSize:10,color:T.textDim,display:"block",marginBottom:4,fontFamily:T.sans}}>Description</label>
                  <textarea value={editingPdk.description||""} onChange={e=>setEditingPdk({...editingPdk,description:e.target.value})}
                    style={{width:"100%",padding:"8px 10px",background:T.bg2,border:`1px solid ${T.border}`,borderRadius:4,color:T.text,fontSize:11,minHeight:50,resize:"vertical",fontFamily:T.sans}}/>
                </div>
                
                {/* Layers Section */}
                <div style={{marginBottom:16}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{fontSize:11,fontWeight:600,color:T.textBright,fontFamily:T.sans}}>Layers</div>
                    <button onClick={()=>{
                      const newLayerNum = Math.max(1, ...Object.keys(editingPdk.layers||{}).filter(k=>!k.startsWith("_")).map(Number).filter(n=>!isNaN(n))) + 1;
                      setEditingPdk({...editingPdk, layers: {...editingPdk.layers, [newLayerNum]: {name:`Layer${newLayerNum}`,description:"",gds_layer:newLayerNum,gds_datatype:0,color:"#888888",opacity:0.7,pattern:"solid"}}});
                    }} style={{background:T.accent,border:"none",color:"#fff",padding:"3px 8px",borderRadius:3,cursor:"pointer",fontSize:9,fontFamily:T.sans}}>+ Add Layer</button>
                  </div>
                  <div style={{maxHeight:200,overflowY:"auto",background:T.bg2,borderRadius:6,padding:8}}>
                    {Object.entries(editingPdk.layers||{}).filter(([k])=>!k.startsWith("_")).map(([layerNum, layer]) => (
                      <div key={layerNum} style={{display:"grid",gridTemplateColumns:"50px 1fr 80px 60px 70px 30px",gap:6,alignItems:"center",marginBottom:6,fontSize:9}}>
                        <input type="number" value={layer.gds_layer||layerNum} onChange={e=>{
                          const newLayers = {...editingPdk.layers};
                          newLayers[layerNum] = {...layer, gds_layer: parseInt(e.target.value)||0};
                          setEditingPdk({...editingPdk, layers: newLayers});
                        }} placeholder="GDS#" style={{padding:4,background:T.bg,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontSize:9}}/>
                        <input type="text" value={layer.name||""} onChange={e=>{
                          const newLayers = {...editingPdk.layers};
                          newLayers[layerNum] = {...layer, name: e.target.value};
                          setEditingPdk({...editingPdk, layers: newLayers});
                        }} placeholder="Name" style={{padding:4,background:T.bg,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontSize:9}}/>
                        <input type="color" value={layer.color||"#888888"} onChange={e=>{
                          const newLayers = {...editingPdk.layers};
                          newLayers[layerNum] = {...layer, color: e.target.value};
                          setEditingPdk({...editingPdk, layers: newLayers});
                        }} style={{width:"100%",height:24,padding:0,border:"none",borderRadius:3,cursor:"pointer"}}/>
                        <input type="number" value={layer.opacity||0.7} step={0.1} min={0} max={1} onChange={e=>{
                          const newLayers = {...editingPdk.layers};
                          newLayers[layerNum] = {...layer, opacity: parseFloat(e.target.value)||0.7};
                          setEditingPdk({...editingPdk, layers: newLayers});
                        }} placeholder="Opacity" style={{padding:4,background:T.bg,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontSize:9}}/>
                        <select value={layer.pattern||"solid"} onChange={e=>{
                          const newLayers = {...editingPdk.layers};
                          newLayers[layerNum] = {...layer, pattern: e.target.value};
                          setEditingPdk({...editingPdk, layers: newLayers});
                        }} style={{padding:4,background:T.bg,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontSize:8}}>
                          <option value="solid">Solid</option>
                          <option value="hatch">Hatch</option>
                          <option value="dots">Dots</option>
                          <option value="diagonal">Diagonal</option>
                          <option value="cross">Cross</option>
                        </select>
                        <button onClick={()=>{
                          const newLayers = {...editingPdk.layers};
                          delete newLayers[layerNum];
                          setEditingPdk({...editingPdk, layers: newLayers});
                        }} style={{background:"#d32f2f",border:"none",color:"#fff",padding:"2px 6px",borderRadius:3,cursor:"pointer",fontSize:9}}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Design Rules Section */}
                <div style={{marginBottom:16}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{fontSize:11,fontWeight:600,color:T.textBright,fontFamily:T.sans}}>Design Rules (DRC)</div>
                    <button onClick={()=>{
                      const layerNames = Object.values(editingPdk.layers||{}).filter(l=>l.name&&!l.name.startsWith("_")).map(l=>l.name);
                      const unusedName = layerNames.find(n=>!editingPdk.design_rules?.[n]) || "NewLayer";
                      setEditingPdk({...editingPdk, design_rules: {...editingPdk.design_rules, [unusedName]: {min_width:0.5,min_space:0.5,min_area:1.0}}});
                    }} style={{background:T.accent,border:"none",color:"#fff",padding:"3px 8px",borderRadius:3,cursor:"pointer",fontSize:9,fontFamily:T.sans}}>+ Add Rule</button>
                  </div>
                  <div style={{maxHeight:150,overflowY:"auto",background:T.bg2,borderRadius:6,padding:8}}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 80px 80px 80px 30px",gap:6,marginBottom:4,fontSize:8,color:T.textDim}}>
                      <span>Layer</span><span>Min Width</span><span>Min Space</span><span>Min Area</span><span></span>
                    </div>
                    {Object.entries(editingPdk.design_rules||{}).filter(([k])=>!k.startsWith("_")).map(([layerName, rule]) => (
                      <div key={layerName} style={{display:"grid",gridTemplateColumns:"1fr 80px 80px 80px 30px",gap:6,alignItems:"center",marginBottom:4,fontSize:9}}>
                        <input type="text" value={layerName} onChange={e=>{
                          const newRules = {...editingPdk.design_rules};
                          newRules[e.target.value] = newRules[layerName];
                          delete newRules[layerName];
                          setEditingPdk({...editingPdk, design_rules: newRules});
                        }} style={{padding:4,background:T.bg,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontSize:9}}/>
                        <input type="number" value={rule.min_width||0} step={0.1} onChange={e=>{
                          const newRules = {...editingPdk.design_rules};
                          newRules[layerName] = {...rule, min_width: parseFloat(e.target.value)||0};
                          setEditingPdk({...editingPdk, design_rules: newRules});
                        }} style={{padding:4,background:T.bg,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontSize:9}}/>
                        <input type="number" value={rule.min_space||0} step={0.1} onChange={e=>{
                          const newRules = {...editingPdk.design_rules};
                          newRules[layerName] = {...rule, min_space: parseFloat(e.target.value)||0};
                          setEditingPdk({...editingPdk, design_rules: newRules});
                        }} style={{padding:4,background:T.bg,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontSize:9}}/>
                        <input type="number" value={rule.min_area||0} step={0.1} onChange={e=>{
                          const newRules = {...editingPdk.design_rules};
                          newRules[layerName] = {...rule, min_area: parseFloat(e.target.value)||0};
                          setEditingPdk({...editingPdk, design_rules: newRules});
                        }} style={{padding:4,background:T.bg,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontSize:9}}/>
                        <button onClick={()=>{
                          const newRules = {...editingPdk.design_rules};
                          delete newRules[layerName];
                          setEditingPdk({...editingPdk, design_rules: newRules});
                        }} style={{background:"#d32f2f",border:"none",color:"#fff",padding:"2px 6px",borderRadius:3,cursor:"pointer",fontSize:9}}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Action Buttons */}
                <div style={{display:"flex",gap:10,justifyContent:"flex-end",borderTop:`1px solid ${T.border}`,paddingTop:16}}>
                  <button onClick={()=>setEditingPdk(null)} style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,padding:"8px 16px",borderRadius:4,cursor:"pointer",fontSize:11,fontFamily:T.sans}}>
                    Cancel
                  </button>
                  <button onClick={()=>savePdk(editingPdk)} disabled={!editingPdk.name?.trim()} style={{background:editingPdk.name?.trim()?"#00695c":"#888",border:"none",color:"#fff",padding:"8px 20px",borderRadius:4,cursor:editingPdk.name?.trim()?"pointer":"not-allowed",fontSize:11,fontWeight:600,fontFamily:T.sans}}>
                    Save PDK
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* STATUS BAR */}
      <div style={{height:22,background:T.bg2,borderTop:`1px solid ${T.border}`,display:"flex",alignItems:"center",padding:"0 16px",gap:14,fontSize:8,color:T.textDim,flexShrink:0,fontFamily:T.sans}}>
        <span>{placed.length} components</span><span>{connections.length} connections</span><span style={{fontVariantNumeric:"tabular-nums"}}>{Math.round(zoom*100)}%</span>
        <span style={{color:gridSnap?T.success:`${T.textDim}55`}}>{gridSnap?`Grid ${effectiveGridSize<1?effectiveGridSize.toFixed(1):effectiveGridSize}µm${autoGrid?" (auto)":""}`:"No grid"}</span>
        <span style={{opacity:0.6}}>Ctrl+S save · Ctrl+O open · Ctrl+Z undo</span>
        <div style={{flex:1}}/><span style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:5,height:5,borderRadius:"50%",background:backendOk?T.success:T.error}}/> Flask {backendOk?"connected":"offline"}</span>
      </div>
    </div>);
}