import { cloneDeep } from 'lodash';

/**
 * A general node for a tree. This can be a node with or without children. The only requirement is that if a node is not
 * a leaf node, it must contain a property `children` that is an array of other tree nodes.
 */
export type TreeNode = {
  /** The children of this node. If `children` is undefined, then this node is a leaf node. */
  children?: TreeNode[];

  /** All other object properties. */
  [name: string]: unknown;
};

/**
 * Similar to {@link Array.findIndex}, `findTreeIndex` looks for the first element in a tree where `predicate` returns
 * true. The tree is indexed in a depth-first, left-to-right order, so the root node will have index 0, its first child
 * will have index 1, and so on.
 * @param node The {@link TreeNode} in which to find the node where `predicate` is true.
 * @param predicate `findTreeIndex` calls predicate once for each element of the tree, in depth-first, left-to-right
 * order, until it finds one where predicate returns true. If such an element is found, `findTreeIndex` immediately
 * returns that element's index in the tree. Otherwise, `findTreeIndex` returns -1.
 * @returns If an element is found, `findTreeIndex` immediately returns that element's index in the tree. Otherwise,
 * `findTreeIndex` returns -1.
 */
export function findTreeIndex<T extends TreeNode>(node: T, predicate: (value: T, index: number) => unknown): number {
  return findTreeIndexHelper(node, 0, predicate).found;
}

/**
 * Similar to {@link Array.slice}, `sliceTree` returns a deep copy of a section of a tree. The tree is indexed in a
 * depth-first, left-to-right order, so the root node will have index 0, its first child will have index 1, and so on.
 * Note that the return value is a full deep clone of every included node, including properties that are not tree
 * properties.
 *
 * A slice of a tree `[start, end)` is defined as a subset of the nodes of the given tree, starting at node with index
 * `start` and all of its ancestors, all nodes with indices between `[start, end)`, up through node with index `end-1`
 * and all of its ancestors.
 *
 * For both start and end, a negative index can be used to indicate an offset from the end of the tree. For example,
 * `-2` refers to the second to last element of the tree and `-1` refers to the last element of the tree.
 * @param node The {@link TreeNode} from which the cloned, sliced subtree will be built.
 * @param start The beginning index of the specified portion of the tree. If start is undefined, then the slice begins
 * at index 0.
 * @param end The end index of the specified portion of the tree. This is exclusive of the element at the index `end`.
 * If end is undefined, then the slice extends to the end of the tree.
 * @returns A deep clone of a subtree, with nodes that have an index less than `start` not included (except ancestors)
 * and nodes that have index greater than or equal to `end` not included (expect ancestors). If no nodes could be
 * included in the slice, `null` is returned.
 */
export function sliceTree<T extends TreeNode>(node: T, start?: number, end?: number): T | null {
  const annotatedSlicedTree = sliceTreeHelper(constructAnnotatedTree(node), start, end);
  if (annotatedSlicedTree === null) {
    return null;
  }
  return destructAnnotatedTree(annotatedSlicedTree);
}

//#region ------- findTreeIndex helpers -----------

function findTreeIndexHelper<T extends TreeNode>(
  node: T,
  currentIndex: number,
  predicate: (value: T, index: number) => unknown,
): { found: number; lastIndex: number } {
  if (predicate(node, currentIndex)) {
    return { found: currentIndex, lastIndex: currentIndex };
  }

  if (node.children === undefined) {
    return { found: -1, lastIndex: currentIndex };
  }

  let lastIndex = currentIndex;
  for (const child of node.children as T[]) {
    const foundResult = findTreeIndexHelper(child, lastIndex + 1, predicate);
    if (foundResult.found !== -1) {
      return { found: foundResult.found, lastIndex: foundResult.lastIndex };
    }
    lastIndex = foundResult.lastIndex;
  }

  return { found: -1, lastIndex: lastIndex };
}

//#endregion ------- findTreeIndex helpers -----------

//#region ------- sliceTree helpers -----------

type AnnotatedTreeNode<T extends TreeNode> = {
  node: Omit<T, 'children'>;
  index: number;
  indexRange: { first: number; last: number };
  children?: AnnotatedTreeNode<T>[];
};

function sliceTreeHelper<T extends TreeNode>(
  node: AnnotatedTreeNode<T>,
  start?: number,
  end?: number,
): AnnotatedTreeNode<T> | null {
  if (start === undefined) {
    start = 0;
  }
  if (start < 0) {
    start = node.indexRange.last + 1 + start;
  }
  if (end === undefined) {
    end = node.indexRange.last + 1;
  }
  if (end < 0) {
    end = node.indexRange.last + 1 + end;
  }

  if (node.indexRange.last < start || node.indexRange.first >= end) {
    // We don't include this node at all because it and all of its children (if any) are out of the slice bounds.
    return null;
  }

  // This node or some of its children are within the slice bounds. If the entire subtree is within the bounds, simply
  // return it.
  if (node.indexRange.first >= start && node.indexRange.last < end) {
    return node;
  }

  // Only part of the subtree is within the slice bounds. Find the ones that are and return those.
  if (node.children === undefined) {
    // We won't actually get here because we've handled the leaf node cases above.
    return null;
  } else {
    const includedChildren: AnnotatedTreeNode<T>[] = [];
    for (const child of node.children) {
      const maybeIncludedChild = sliceTreeHelper(child, start, end);
      if (maybeIncludedChild !== null) {
        includedChildren.push(maybeIncludedChild);
      }
    }
    return {
      node: node.node,
      index: node.index,
      indexRange: node.indexRange,
      children: includedChildren,
    };
  }
}

function constructAnnotatedTree<T extends TreeNode>(node: T): AnnotatedTreeNode<T> {
  const clonedTree = cloneDeep(node);
  return constructAnnotatedTreeHelper(clonedTree, 0);
}

function constructAnnotatedTreeHelper<T extends TreeNode>(node: T, currentIndex: number): AnnotatedTreeNode<T> {
  if (node.children === undefined) {
    // This is a leaf node.
    return { node, index: currentIndex, indexRange: { first: currentIndex, last: currentIndex } };
  }

  const annotatedChildren: AnnotatedTreeNode<T>[] = [];
  let lastIndex = currentIndex;
  for (let i = 0, childIndex = lastIndex + 1; i < node.children.length; i++, childIndex = lastIndex + 1) {
    const annotatedChild = constructAnnotatedTreeHelper(node.children[i] as T, childIndex);
    annotatedChildren.push(annotatedChild);
    lastIndex = annotatedChild.indexRange.last;
  }

  // Remove the children from the original node. Otherwise we'll have two `children` arrays floating around.
  delete node.children;

  return {
    node,
    children: annotatedChildren,
    index: currentIndex,
    indexRange: { first: currentIndex, last: lastIndex },
  };
}

function destructAnnotatedTree<T extends TreeNode>(annotatedNode: AnnotatedTreeNode<T>): T {
  if (annotatedNode.children === undefined) {
    return annotatedNode.node as T;
  }

  // Put the children back in their original spot.
  const children: T[] = [];
  for (const child of annotatedNode.children) {
    children.push(destructAnnotatedTree(child));
  }
  (annotatedNode.node as T).children = children;
  return annotatedNode.node as T;
}

//#endregion ------- sliceTree helpers -----------
