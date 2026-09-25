// Specification support utility, not an application implementation.
import { writeFileSync } from 'node:fs';
export function rgbToLab(rgb) {
  const [r,g,b] = rgb.map(v => { const c=v/255; return c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4; });
  const x=(0.4124564*r+0.3575761*g+0.1804375*b)/0.95047;
  const y=0.2126729*r+0.7151522*g+0.0721750*b;
  const z=(0.0193339*r+0.1191920*g+0.9503041*b)/1.08883;
  const f=t => t>216/24389 ? Math.cbrt(t) : (24389/27*t+16)/116;
  return [116*f(y)-16,500*(f(x)-f(y)),200*(f(y)-f(z))];
}
// name | sRGB hex | family | aliases
const rows=`Black|101114|neutral|Jet Black
Soft Black|242529|neutral|Washed Black
Charcoal|383B40|neutral|Anthracite
Dark Gray|55585D|neutral|Dark Grey
Gray|808287|neutral|Grey
Light Gray|C5C7CB|neutral|Light Grey
Silver Gray|A9ADB3|neutral|Silver
White|FFFFFF|neutral|Pure White
Off White|F5F3EB|neutral|Off-white
Cream|F3E5C3|brown|Vanilla
Ivory|F6EED7|brown|Ecru White
Beige|D4BE9C|brown|Sand
Tan|B58B61|brown|Camel
Khaki|A49A70|brown|Khaki Tan
Taupe|918477|brown|Mushroom
Brown|805536|brown|Chocolate Brown
Dark Brown|493225|brown|Espresso
Cocoa|9B765D|brown|Light Brown
Red|C8323E|red|True Red
Bright Red|E32636|red|Scarlet
Dark Red|922C36|red|Wine Red
Burgundy|682D40|red|Wine
Maroon|632F32|red|Oxblood
Pink|E68DA9|red|Rose Pink
Light Pink|F3C6D3|red|Baby Pink
Dusty Rose|BD8290|red|Muted Rose
Hot Pink|D93683|red|Fuchsia Pink
Coral|EB8174|orange|Coral Pink
Orange|E67E32|orange|Tangerine
Rust|AC5235|orange|Burnt Orange
Peach|F3BE9A|orange|Apricot
Yellow|EFD45B|yellow|Golden Yellow
Pale Yellow|F4E9AC|yellow|Butter Yellow
Mustard|B89A37|yellow|Ochre
Olive|737347|green|Olive Green
Green|46845B|green|Medium Green
Dark Green|294F3D|green|Forest Green
Emerald|24836A|green|Emerald Green
Sage|A2AF95|green|Sage Green
Mint|B4DDC5|green|Mint Green
Teal|327D80|green|Blue Green
Dark Teal|27545C|green|Deep Teal
Turquoise|56B8BA|blue|Aqua
Light Blue|B0CDE4|blue|Baby Blue
Sky Blue|78B2D7|blue|Azure Blue
Blue|417BAD|blue|Medium Blue
Royal Blue|3657AD|blue|Cobalt
Navy|202E4D|blue|Navy Blue
Dark Blue|2C4266|blue|Deep Blue
Denim Blue|526F88|blue|Denim
Faded Denim|8DA5B8|blue|Washed Denim
Indigo|414568|blue|Indigo Blue
Purple|795387|purple|Violet
Dark Purple|503653|purple|Aubergine
Plum|765568|purple|Muted Purple
Lavender|C5B3DC|purple|Lilac
Pale Lavender|DDD3EB|purple|Pastel Purple`;
const familyGroup={red:'reds-pinks',orange:'yellows-oranges',yellow:'yellows-oranges',green:'greens',blue:'blues',brown:'browns-beiges',purple:'other',neutral:'grays'};
const colors=rows.split('\n').map(row=>{
 const [name,hex,family,alias]=row.split('|');
 const rgb=hex.match(/../g).map(v=>parseInt(v,16)); const lab=rgbToLab(rgb);
 const C=Math.hypot(lab[1],lab[2]);
 const laundryGroup=lab[0]>=94&&C<=4?'whites':lab[0]<38?'darks':family==='red'?'reds-pinks':lab[0]>=75?'lights':familyGroup[family];
 return {id:name.toLowerCase().replaceAll(' ','-'),name,hex:'#'+hex,rgb,lab:lab.map(v=>+v.toFixed(5)),laundryGroup,family,aliases:[alias]};
});
writeFileSync(new URL('./colors.json',import.meta.url),JSON.stringify({schemaVersion:1,paletteVersion:'1.0.0',colorSpace:'CIELAB-D65-2deg',source:'Curated illustrative sRGB anchors; not measured textile standards',colors},null,2)+'\n');
