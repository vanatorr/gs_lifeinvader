# Atelier ped preview: contract for the three.js viewer

This folder is the static asset contract for a real-GTA-character tattoo preview, replacing the
stylized SVG silhouette in `citadel/src/app/atelier/TattooPlacementEditor.tsx`. The owner's complaint
was that "placing a tattoo doesnt have a gta5 char with acc accurate placement". These assets carry the
real freemode bodies and the EXACT projection math the desktop forge tool uses, so a three.js viewer can
reproduce the game's placement instead of approximating it in 2D.

Everything here was produced by `gs-texture-optimizer tools/PedGltfExport` (an uncommitted local tool)
from a legal local GTA V Legacy install (build 1.0.231.0), read-only. Nothing was invented: the geometry,
the UVs, the textures and the aspect factors are all measured off the real meshes.

## Files

| File | Size | What it is |
|------|------|------------|
| `male.glb` | ~1.04 MB | `mp_m_freemode_01` bare body (head + uppr + lowr), glTF 2.0 binary |
| `female.glb` | ~0.98 MB | `mp_f_freemode_01` bare body (head + uppr + lowr + feet) |
| `projection.json` | ~7 KB | the machine-readable projection spec. THIS is the source of truth for the math below |
| `decal_calibration.png` | ~8 KB | an asymmetric calibration decal, used to render the references |
| `reference_male.png` | ~130 KB | ground-truth render of the calibration decal at TAT_AR_008's placement, male |
| `reference_female.png` | ~130 KB | same, female |
| `_export_meta.json` | ~4 KB | export stats (primitive/vertex/triangle counts, texture sizes, measured aspect) |

Both `.glb` files are valid glTF 2.0 (verified with an independent binary parser: header, chunk framing,
buffer/bufferView/accessor bounds, 4-byte alignment, index-in-range, PNG image signatures, and presence
of both UV sets on every skin primitive). They are well under the 8 MB web budget.

## The one idea you must internalise

A tattoo's `uvPos` / `scale` / `rotation` are **not** a rectangle on the skin texture. They are a
rectangle in the ped's **decoration unwrap**: a SECOND UV set Rockstar baked into the mesh. It is
exported as **`TEXCOORD_1`** (`uv1` in three.js r125+, `uv2` on older builds). `TEXCOORD_0` is the
ordinary skin unwrap used by the embedded skin material; **do not use it for placement.**

Why this matters and why the old 2D silhouette can never be right:
- `uvPos.x` is an **angle around the limb**. It wraps and legitimately runs outside `[0,1]`.
- The **left and right limbs share every skin texel** but live in **different bands** of the decoration
  unwrap. That is the only reason one arm can be inked and the other left clean. A skin-texture rectangle
  physically cannot express that; the unwrap can.

## Rendering recipe (do this)

Reproduce the game exactly with a **decal shell built on `uv1`**, which is what the desktop tool does and
what produced the reference images. Do **not** use a planar projector (`THREE.DecalGeometry`): it looks
plausible but cannot wrap around a limb or keep the two arms separate.

All constants and formulas are in `projection.json`. In prose:

1. **Load** the gender's `.glb`. It is a static A-pose, Y-up, positions in metres (~1.8 m tall). The ped
   faces **+Z**; glTF cameras look down -Z, so to see the face put the camera on +Z looking toward -Z (or
   rotate the model 180 deg about Y). Materials are `doubleSided`, so culling is not a concern.

2. **Pick the zone's band.** Each zone has a `zoneId` (0 torso, 1 head, 2 left arm, 3 right arm, 4 left
   leg, 5 right leg). `ZONE_TORSO` and `ZONE_FRONT` are BOTH `zoneId` 0; they differ only by where
   `uvPos.x` sits around the torso (back ~0.23, front ~0.73), never by band.

3. **Aspect-correct the scale** (this is the step the old 2D editor could skip and the 3D one cannot):
   ```
   extentAround = scale.x * turnsPerUnitScale[gender][zoneId]   // per-gender table in projection.json
   extentAlong  = scale.y
   ```
   Keep the sign of `scale.x`: a negative width mirrors the art. Without this, arm/leg tattoos render
   about 3x too tall.

4. **For each triangle** of the base mesh whose vertices carry `uv1`:
   - For each corner, from raw `uv1 = (rawU, rawV)`:
     ```
     around = rawU - 1.0                       // uOrigin = 1.0
     along  = -(2.0 * zoneId) - rawV           // 0 = far end of limb, 1 = at the body
     ```
   - **Zone gate:** keep the triangle only if ANY corner has `along` in `[-0.5, 1.5]` for this zoneId.
     Triangles on the other limb are two whole bands away and never qualify.
   - **Seam fix:** `around` wraps, so snap the branches together per triangle:
     `branch(u, near) = u + round(near - u)`; set `around0 = branch(around0, uvPos.x)`, then
     `around1 = branch(around1, around0)`, `around2 = branch(around2, around0)`.
   - **To decal UV** (art space, `(0,0)` = top-left of the PNG):
     ```
     x = (around - uvPos.x) / extentAround
     y = (along  - uvPos.y) / extentAlong
     a = -rotationDegrees * PI/180             // note the NEGATIVE sign
     rx =  x*cos(a) + y*sin(a)
     ry = -x*sin(a) + y*cos(a)
     decalU = rx + 0.5
     decalV = 0.5 - ry                         // VERTICAL FLIP, not optional
     ```
   - **Cull:** drop the triangle if its three decal-UVs' bounding box does not intersect `[0,1]x[0,1]`,
     or if it spans more than 4 units on either axis (a seam/wrap artefact).
   - Emit the surviving triangle into a shell mesh: copy the vertex positions (lifted **0.002 m** along
     the vertex normal so it does not z-fight the body) and set the vertex UV to `(decalU, decalV)`.

5. **Draw the shell** with the decal texture, sampling **clamp-to-transparent** outside `[0,1]` (three.js:
   `ClampToEdgeWrapping` plus a transparent-border texture, or discard in a shader when uv is outside
   `[0,1]`). Do NOT tile. Honour the decal's alpha (a real tattoo sheet is mostly transparent).

That shell, over the base body, is the preview. It is the same construction that rendered
`reference_male.png` / `reference_female.png`.

## What the numbers mean (quick reference)

- `uvPos`: CENTRE of the decal. `.x` = centre around the limb (turns, wraps), `.y` = centre along it
  (0 far end .. 1 body).
- `scale`: FULL width/height, both in units of the zone's LENGTH. Equal x and y = a square patch.
- `rotationDegrees`: clockwise, about the art's centre.
- `turnsPerUnitScale[gender][zone]`: how many turns-around one unit of length-scale is worth. Measured
  per mesh; male and female differ. Good to about a fifth (a limb is a cone), which is why real placements
  land within ~a quarter of square rather than dead on.

## Verify against the references

`reference_{male,female}.png` are the desktop tool's own render of `decal_calibration.png` at:
`ZONE_TORSO`, `uvPos (0.6571, 0.6122)`, `scale (0.0722, 0.0872)`, `rotation 0` (the real TAT_AR_008
placement from `gs_tattooshop/addon/gs_overlays/gs_overlays.xml`). Render the same decal at the same
placement in your viewer, front-on, and compare: the calibration art is asymmetric on purpose so every
axis is checkable at a glance:

- **cyan bar** = the art's TOP edge (small v)
- **magenta bar** = the art's LEFT edge (small u)
- **red corner square** = the art's `(0,0)`
- **green arrow** points to the art's UP (rotation 0)

If your arrow points up, the cyan sits at the top of the patch, and the patch lands on the same upper-chest
spot, your projection matches. If the tattoo is upside down you dropped the `decalV = 0.5 - ry` flip; if
it is 3x too tall you skipped the aspect correction; if it smears around the torso you skipped the seam
branch snap or the span cull.

## What was verified, and what was not

- Verified: both `.glb` load and pass an independent binary glTF parse; both UV channels present on every
  skin primitive; male vertex count 6801 matches the desktop tool's own measurement; the `uv1` v-ranges
  land in the expected disjoint per-zone bands; the reference renders show the calibration decal correctly
  oriented on the real bodies at the real placement; aspect factors match the desktop tool's documented
  values (male torso 0.84, arm 2.66; female torso 1.15).
- NOT done here (web agent's job): the actual three.js viewer, wiring it into
  `TattooPlacementEditor.tsx`, and a live pixel comparison of the viewer's output against the references.
- Textures are the per-component skin diffuse only (`*_diff_*_a_whi`, DXT-compressed 512/256, decoded and
  re-embedded as PNG). Non-skin head details (eyes/mouth) inherit the skin material; this is a placement
  base, not a beauty render. The skin tone is the single `whi` body tone GTA ships (other tones are a
  shader palette, not separate sheets).
