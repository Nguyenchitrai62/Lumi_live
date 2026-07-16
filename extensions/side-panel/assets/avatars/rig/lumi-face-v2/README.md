# Lumi face rig v2

This is a component-based VTuber facial rig shared by the Next.js stage and standalone Side Panel extension.

## Runtime layers

- `hair-back-casual.png`, `hair-back-moonlit.png`: rear/side hair pixels extracted directly from each original portrait and rendered behind the body/face.
- `base-casual.png`, `base-moonlit.png`: body, clothing, head, and locally cleaned face between the two hair layers.
- `eyes-open.png`, `eyes-half.png`, `eyes-closed.png`: independent generated eye-pair sprites. Their alpha bounds contain eye artwork only—no skin, hair, or face patch.
- `mouth-neutral.png`, `mouth-small.png`, `mouth-wide.png`: independent generated mouth sprites. Their alpha bounds contain mouth artwork only—no skin or face patch.
- `hair-front-casual.png`, `hair-front-moonlit.png`: original bangs and front locks rendered above the eyes/mouth, preventing facial cleanup or sprites from cutting into the hair.

Every file uses the same transparent 1086x1448 canvas so the browser only changes layer opacity; no runtime coordinate scaling is required. Hair layers are static and only provide correct front/back occlusion—there is no hair animation.

## Generation provenance

The six sprites were created in built-in imagegen mode from the original Lumi neutral/speaking portraits. Each prompt requested exactly one eye pair or mouth state on a perfectly flat `#00ff00` chroma-key background, while locking the original identity, geometry, violet palette, line art, and anime rendering style. Prompts explicitly excluded skin, face, hair, text, shadows, and all non-target parts.

The imagegen skill's `remove_chroma_key.py` helper converted the green backgrounds to alpha using border key detection, soft matte, and despill. The visible sprite bounds were then scaled and placed mechanically on the common canvas without repainting. The two base images were produced locally with feathered masks and a fitted skin-color surface, guaranteeing that artwork outside the eye/mouth masks is not regenerated.
