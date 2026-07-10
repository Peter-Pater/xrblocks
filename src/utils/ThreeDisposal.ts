import * as THREE from 'three';

export function disposeMaterial(
  material: THREE.Material | THREE.Material[] | undefined,
  except = new Set<THREE.Material>()
) {
  if (!material) {
    return;
  }
  const materials = Array.isArray(material) ? material : [material];
  for (const item of materials) {
    if (!except.has(item)) {
      item.dispose();
    }
  }
}

export function disposeMeshResources(mesh: THREE.Mesh) {
  mesh.geometry?.dispose();
  disposeMaterial(mesh.material);
}

export function disposeObjectTree(object: THREE.Object3D) {
  for (const child of [...object.children]) {
    disposeObjectTree(child);
    object.remove(child);
  }

  const disposable = object as {dispose?: () => void};
  if (disposable.dispose) {
    disposable.dispose();
  } else if (object instanceof THREE.Mesh) {
    disposeMeshResources(object);
  }
}

export function disposeObjectChildren(object: THREE.Object3D) {
  for (const child of [...object.children]) {
    disposeObjectTree(child);
    object.remove(child);
  }
}
