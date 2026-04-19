# GLTF Viewer — Node.js + EJS

A 3D GLTF model viewer with collection/object toggle checkboxes.

## Setup

```bash
npm install
npm start
# → http://localhost:3000
```

## Model folder structure

Place your models inside the `/models` directory:

```
models/
├── CollectionA/
│   ├── Chair/
│   │   ├── Chair.gltf
│   │   ├── Chair.bin
│   │   └── textures/
│   │       └── chair_diffuse.png
│   └── Table/
│       ├── Table.gltf
│       ├── Table.bin
│       └── textures/
└── CollectionB/
    └── Car/
        ├── Car.gltf
        ├── Car.bin
        └── textures/
```

- Each top-level folder = **Collection**
- Each subfolder with a `.gltf`/`.glb` inside = **Object**
- Textures live inside each model's own folder (standard GLTF texture referencing)

## Features

- ✅ Toggle entire **collections** on/off
- ✅ Toggle individual **objects** on/off  
- ✅ Click ⊕ to **focus camera** on a model
- ✅ Grid, wireframe, reset camera controls
- ✅ Drag & drop `.gltf` / `.glb` from desktop
- ✅ Load progress indicator