// Copyright (c) 2015 - 2017 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

/* global window */
import mat4_multiply from 'gl-mat4/multiply';
import vec4_transformMat4 from 'gl-vec4/transformMat4';

import log from '../../utils/log';
import assert from 'assert';
import {COORDINATE_SYSTEM} from '../../lib/constants';

import {projectFlat} from 'viewport-mercator-project';

// To quickly set a vector to zero
const ZERO_VECTOR = [0, 0, 0, 0];
// 4x4 matrix that drops 4th component of vector
const VECTOR_TO_POINT_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// TODO - import these utils from fp64 package
function fp64ify(a, array = [], startIndex = 0) {
  const hiPart = Math.fround(a);
  const loPart = a - hiPart;
  array[startIndex] = hiPart;
  array[startIndex + 1] = loPart;
  return array;
}

// calculate WebGL 64 bit matrix (transposed "Float64Array")
function fp64ifyMatrix4(matrix) {
  // Transpose the projection matrix to column major for GLSL.
  const matrixFP64 = new Float32Array(32);
  for (let i = 0; i < 4; ++i) {
    for (let j = 0; j < 4; ++j) {
      const index = i * 4 + j;
      fp64ify(matrix[j * 4 + i], matrixFP64, index * 2);
    }
  }
  return matrixFP64;
}

// Calculate transformed projectionCenter (using 64 bit precision JS)
// This is the key to offset mode precision
// (avoids doing this addition in 32 bit precision in GLSL)
function calculateProjectionCenter({coordinateOrigin, coordinateZoom, viewProjectionMatrix}) {
  const positionPixels = projectFlat(coordinateOrigin, Math.pow(2, coordinateZoom));
  // projectionCenter = new Matrix4(viewProjectionMatrix)
  //   .transformVector([positionPixels[0], positionPixels[1], 0.0, 1.0]);
  return vec4_transformMat4([],
    [positionPixels[0], positionPixels[1], 0.0, 1.0],
    viewProjectionMatrix);
}

// The code that utilizes Matrix4 does the same calculation as their mat4 counterparts,
// has lower performance but provides error checking.
// Uncomment when debugging
function calculateMatrixAndOffset({
  // UNCHANGED
  viewport,
  modelMatrix,
  // NEW PARAMS
  coordinateSystem,
  coordinateOrigin,
  coordinateZoom
}) {
  const {viewMatrixUncentered} = viewport;
  let {viewMatrix} = viewport;
  const {projectionMatrix} = viewport;
  let {viewProjectionMatrix} = viewport;

  let projectionCenter;

  switch (coordinateSystem) {

  case COORDINATE_SYSTEM.IDENTITY:
  case COORDINATE_SYSTEM.LNGLAT:
    projectionCenter = ZERO_VECTOR;
    break;

  // TODO: make lighitng work for meter offset mode
  case COORDINATE_SYSTEM.METER_OFFSETS:
    projectionCenter = calculateProjectionCenter({
      coordinateOrigin, coordinateZoom, viewProjectionMatrix
    });

    // Always apply uncentered projection matrix if available (shader adds center)
    viewMatrix = viewMatrixUncentered || viewMatrix;

    // Zero out 4th coordinate ("after" model matrix) - avoids further translations
    // viewMatrix = new Matrix4(viewMatrixUncentered || viewMatrix)
    //   .multiplyRight(VECTOR_TO_POINT_MATRIX);
    viewProjectionMatrix = mat4_multiply([], projectionMatrix, viewMatrix);
    viewProjectionMatrix = mat4_multiply([], viewProjectionMatrix, VECTOR_TO_POINT_MATRIX);
    break;

  default:
    throw new Error('Unknown projection mode');
  }

  return {
    viewMatrix,
    viewProjectionMatrix,
    projectionCenter,
    cameraPos: viewport.cameraPosition
  };
}

/**
 * Returns uniforms for shaders based on current projection
 * includes: projection matrix suitable for shaders
 *
 * TODO - Ensure this works with any viewport, not just WebMercatorViewports
 *
 * @param {WebMercatorViewport} viewport -
 * @return {Float32Array} - 4x4 projection matrix that can be used in shaders
 */
export function getUniformsFromViewport({
  viewport,
  modelMatrix = null,
  coordinateSystem = COORDINATE_SYSTEM.LNGLAT,
  coordinateOrigin = [0, 0],
  fp64 = false,
  // Deprecated
  projectionMode,
  positionOrigin
} = {}) {
  assert(viewport);

  if (projectionMode !== undefined) {
    log.removed('projectionMode', 'coordinateSystem');
  }
  if (positionOrigin !== undefined) {
    log.removed('positionOrigin', 'coordinateOrigin');
  }

  const coordinateZoom = viewport.zoom;
  assert(coordinateZoom >= 0);

  const {projectionCenter, viewProjectionMatrix, cameraPos} =
    calculateMatrixAndOffset({
      coordinateSystem, coordinateOrigin, coordinateZoom, modelMatrix, viewport
    });

  assert(viewProjectionMatrix, 'Viewport missing modelViewProjectionMatrix');

  // Calculate projection pixels per unit
  const distanceScales = viewport.getDistanceScales();

  // TODO - does this depend on useDevicePixels?
  const devicePixelRatio = (window && window.devicePixelRatio) || 1;
  const viewportSize = [viewport.width * devicePixelRatio, viewport.height * devicePixelRatio];

  const glModelMatrix = modelMatrix || IDENTITY_MATRIX;

  const uniforms = {
    // Projection mode values
    project_uCoordinateSystem: coordinateSystem,
    project_uCenter: projectionCenter,

    // Screen size
    project_uViewportSize: viewportSize,
    project_uDevicePixelRatio: devicePixelRatio,

    // Distance at which screen pixels are projected
    project_uFocalDistance: viewport.focalDistance || 1,
    project_uPixelsPerUnit: distanceScales.pixelsPerMeter,
    project_uScale: viewport.scale, // This is the mercator scale (2 ** zoom)

    project_uModelMatrix: glModelMatrix,
    project_uViewProjectionMatrix: viewProjectionMatrix,

    // This is for lighting calculations
    project_uCameraPosition: cameraPos,

    //
    // DEPRECATED UNIFORMS - For backwards compatibility with old custom layers
    //
    projectionMode: coordinateSystem,
    projectionCenter,

    projectionOrigin: coordinateOrigin,
    modelMatrix: glModelMatrix,
    viewMatrix: viewport.viewMatrix,
    projectionMatrix: viewProjectionMatrix,
    projectionPixelsPerUnit: distanceScales.pixelsPerMeter,
    projectionScale: viewport.scale, // This is the mercator scale (2 ** zoom)
    viewportSize,
    devicePixelRatio,
    cameraPos
  };

  // TODO - fp64 flag should be from shader module, not layer props
  return fp64 ? addFP64Uniforms(uniforms) : uniforms;
}

// 64 bit projection support
function addFP64Uniforms(uniforms) {
  const glViewProjectionMatrixFP64 = fp64ifyMatrix4(uniforms.project_uViewProjectionMatrix);
  const scaleFP64 = fp64ify(uniforms.project_uScale);

  uniforms.project_uViewProjectionMatrixFP64 = glViewProjectionMatrixFP64;
  uniforms.project64_uViewProjectionMatrix = glViewProjectionMatrixFP64;
  uniforms.project64_uScale = scaleFP64;

  // DEPRECATED UNIFORMS - For backwards compatibility with old custom layers
  uniforms.projectionFP64 = glViewProjectionMatrixFP64;
  uniforms.projectionScaleFP64 = scaleFP64;

  return uniforms;
}
