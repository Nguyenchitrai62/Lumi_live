# Lumi VTuber avatar

This component-based VTuber facial rig is shared by the Next.js app and the Lumi Live extension.

## Runtime layers

- `hair-back-casual.png`, `hair-back-moonlit.png`: regenerated continuous rear-hair curtains rendered behind the head and body. The center deliberately extends under the opaque base so gaps cannot appear around the ears, jaw, neck, or shoulders.
- `base-casual.png`, `base-moonlit.png`: regenerated head-and-body artwork with clean blank eye and mouth areas, rendered between the two hair layers.
- `eyes-open.png`, `eyes-half.png`, `eyes-closed.png`: the original independent eye-pair sprites. These were not changed during the body/hair regeneration.
- `mouth-neutral.png`, `mouth-small.png`, `mouth-wide.png`: the original independent mouth sprites. These were not changed during the body/hair regeneration.
- `hair-front-casual.png`, `hair-front-moonlit.png`: regenerated front cap, bangs, side fringe, and front locks rendered above the eye and mouth sprites. The clean original star hair clip is included in this top layer.

Every file uses the same transparent 1086x1448 canvas. The browser swaps eye and mouth opacity without runtime coordinate scaling. Hair layers are static and provide correct front/back occlusion; there is no hair animation.

The `references` directory contains the two original closed-eye outfit portraits used only for asset regeneration. The extension build excludes these reference images.

## Generation provenance

The six head/body/hair assets were regenerated with built-in ImageGen from the matching Lumi rig layers and original outfit portraits. Each request locked the original identity, canvas registration, pale blue/violet palette, line art, pose, outfit, and anime rendering style. Head and body were generated together, while front and rear hair were generated as separate rig layers. The two base layers received a second identity-preserving pass that treated the full original portraits as immutable geometry references, restoring the original cheek taper, jaw, chin, neck, shoulders, and body proportions while keeping blank eye and mouth areas for the existing sprites. Original nose-highlight landmarks were then used to register the casual base 13 pixels right and the moonlit base 3 pixels right, keeping the unchanged eye and mouth sprites on the same facial axis as the source portraits.

Generation used a flat `#ff0000` chroma background. The red matte was converted to alpha, edge spill was removed, and all outputs were normalized to the shared 1086x1448 canvas. The star hair clip was preserved from the clean original component and composited into each regenerated front-hair layer.

The six eye and mouth sprites retain their earlier ImageGen/chroma-key artwork unchanged. This keeps the established blink and lip-sync animation while replacing the rough separated head/body/hair artwork.
