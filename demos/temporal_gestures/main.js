import 'xrblocks/addons/simulator/SimulatorAddons.js';

import * as uikit from '@pmndrs/uikit';
import * as THREE from 'three';
import {ManipulationBehavior, UICore, UIPanel, UIText} from 'uiblocks';
import * as xb from 'xrblocks';

const options = new xb.Options();
options.enableUI();
options.enableGestures();
options.enableHeadGestures();
options.uikit.enable(uikit);
options.gestures.setHistoryDurationMs(2500);
options.gestures.setMaximumSampleGapMs(400);
for (const name of Object.keys(options.gestures.gestures)) {
  options.gestures.setGestureEnabled(name, false);
}
options.gestures.setGestureEnabled('shoo', true);
// A headset-friendly profile. The SDK defaults remain more conservative, so
// applications can choose their own device and interaction tradeoffs.
options.gestures.setGestureConfig('shoo', {
  threshold: THREE.MathUtils.degToRad(10),
  parameters: {
    minimumDurationMs: 180,
    maximumDurationMs: 1500,
    horizontalToleranceDegrees: 35,
    minimumOpenness: 0.58,
    maximumTranslation: 1.25,
    minimumAngularSpeedDegreesPerSecond: 40,
    maximumPoseDropoutMs: 140,
    detectionHoldMs: 300,
  },
});
options.gestures.setGestureEnabled('beckon', true);
options.gestures.setGestureConfig('beckon', {
  threshold: THREE.MathUtils.degToRad(6),
  parameters: {
    reversalCount: 1,
    minimumDurationMs: 100,
    maximumDurationMs: 2400,
    verticalToleranceDegrees: 65,
    maximumThumbsUpConfidence: 0.5,
    maximumTranslation: 5,
    minimumAngularSpeedDegreesPerSecond: 4,
    maximumPoseDropoutMs: 600,
    detectionHoldMs: 500,
    continuationWindowMs: 400,
    minimumContinuationDegrees: 1.5,
  },
});
options.gestures.setGestureEnabled('thumbs-up', true);
options.gestures.setGestureConfig('thumbs-up', {
  parameters: {
    maximumThumbTiltDeviationDegrees: 20,
    minimumThumbStraightness: 0.75,
    minimumOtherFingerCurl: 0.6,
    minimumThumbSeparation: 0.4,
    motionLookbackMs: 350,
    maximumRecentAngularMovementDegrees: 15,
    maximumRecentTranslation: 0.4,
  },
});
options.hands.enabled = true;
options.hands.visualization = true;
options.hands.visualizeJoints = true;
options.hands.visualizeMeshes = true;
options.simulator.defaultMode = xb.SimulatorMode.CONTROLLER;
options.setAppTitle('Temporal Gestures');
options.setAppDescription(
  'Try head gestures, thumbs up, shoo, and beckon motions.'
);
options.xrButton.showEnterSimulatorButton = true;

class TemporalGestureHUD extends xb.Script {
  constructor() {
    super();
    this.uiCore = new UICore(this);
    this.handResults = {left: new Map(), right: new Map()};
  }

  init() {
    this.createSpatialHUD();
    this.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2));

    this.onHeadGesture = (event) => {
      this.showResult('head', event.detail);
      window.clearTimeout(this.headClearTimeout);
      this.headClearTimeout = window.setTimeout(() => this.clear('head'), 1200);
    };
    xb.input.headGestures?.addEventListener('gesture', this.onHeadGesture);

    const handGestures = xb.core.gestureRecognition;
    this.onHandGesture = (event) => this.updateHandResult(event.detail);
    this.onHandGestureEnd = (event) => this.endHandResult(event.detail);
    handGestures?.addEventListener('gesturestart', this.onHandGesture);
    handGestures?.addEventListener('gestureupdate', this.onHandGesture);
    handGestures?.addEventListener('gestureend', this.onHandGestureEnd);
  }

  createSpatialHUD() {
    const card = this.uiCore.createCard({
      name: 'TemporalGestureHUD',
      sizeX: 0.9,
      sizeY: 0.68,
      position: new THREE.Vector3(0.48, 1.35, -1.1),
      behaviors: [
        new ManipulationBehavior({
          draggable: true,
          faceCamera: true,
          manipulationMargin: 64,
          manipulationCornerRadius: 30,
        }),
      ],
    });
    const panel = new UIPanel({
      width: '100%',
      height: '100%',
      fillColor: 'rgba(10, 15, 28, 0.92)',
      strokeWidth: 3,
      strokeColor: '#60a5fa',
      cornerRadius: 24,
      padding: 22,
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: 10,
    });
    panel.add(
      new UIText('TEMPORAL GESTURES', {
        width: '100%',
        fontSize: 25,
        fontWeight: 'bold',
        color: '#93c5fd',
        textAlign: 'center',
      }),
      new UIText(
        'THUMBS UP: thumb vertical. SHOO: hand axis sideways. BECKON: hand axis up, rock wrist.',
        {
          width: '100%',
          fontSize: 14,
          color: '#cbd5e1',
          textAlign: 'center',
          marginBottom: 3,
        }
      )
    );

    this.resultViews = {};
    for (const channel of ['head', 'left', 'right']) {
      const resultView = this.createResultRow(channel);
      this.resultViews[channel] = resultView;
      panel.add(resultView.row);
    }
    card.add(panel);
  }

  createResultRow(channel) {
    const summary = new UIText('Waiting', {
      width: '100%',
      fontSize: 18,
      fontWeight: 'bold',
      color: '#f8fafc',
    });
    const diagnostics = new UIText('No diagnostics', {
      width: '100%',
      fontSize: 13,
      color: '#94a3b8',
    });
    const content = new UIPanel({
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: 'column',
      gap: 3,
    }).add(summary, diagnostics);
    const row = new UIPanel({
      width: '100%',
      height: 112,
      paddingTop: 9,
      paddingBottom: 9,
      paddingLeft: 12,
      paddingRight: 12,
      cornerRadius: 12,
      fillColor: 'rgba(255, 255, 255, 0.06)',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    }).add(
      new UIText(channel.toUpperCase(), {
        width: 72,
        fontSize: 14,
        fontWeight: 'bold',
        color: '#60a5fa',
      }),
      content
    );
    return {
      row,
      summary,
      diagnostics,
      active: false,
      summaryText: 'Waiting',
      diagnosticsText: 'No diagnostics',
    };
  }

  updateHandResult(detail) {
    const {hand, name} = detail;
    this.handResults[hand].set(name, detail);
    this.refreshHand(hand);
  }

  endHandResult({hand, name}) {
    this.handResults[hand].delete(name);
    this.refreshHand(hand);
  }

  refreshHand(hand) {
    const activeResults = Array.from(this.handResults[hand].values());
    if (activeResults.length) this.showHandResults(hand, activeResults);
    else this.clear(hand);
  }

  showHandResults(hand, results) {
    const view = this.resultViews[hand];
    results.sort(
      (a, b) =>
        ['thumbs-up', 'shoo', 'beckon'].indexOf(a.name) -
        ['thumbs-up', 'shoo', 'beckon'].indexOf(b.name)
    );
    const summaryText = results
      .map(
        (detail) =>
          `${formatGestureName(detail.name)}  ${Math.round(detail.confidence * 100)}%`
      )
      .join('\n');
    const diagnosticsText = results
      .map(
        (detail) =>
          `${formatGestureName(detail.name)}: ${formatCompactDiagnostics(detail.data)}`
      )
      .join('\n');
    this.updateResultView(view, summaryText, diagnosticsText);
  }

  showResult(channel, detail) {
    const view = this.resultViews[channel];
    const summaryText = `${formatGestureName(detail.name)}  ${Math.round(detail.confidence * 100)}%`;
    const diagnosticsText = formatDiagnostics(detail.data);
    this.updateResultView(view, summaryText, diagnosticsText);
  }

  updateResultView(view, summaryText, diagnosticsText) {
    if (summaryText !== view.summaryText) {
      view.summary.setText(summaryText);
      view.summaryText = summaryText;
    }
    if (diagnosticsText !== view.diagnosticsText) {
      view.diagnostics.setText(diagnosticsText);
      view.diagnosticsText = diagnosticsText;
    }
    if (!view.active) {
      view.summary.setColor('#86efac');
      view.active = true;
    }
  }

  clear(channel) {
    const view = this.resultViews[channel];
    if (!view.active) return;
    view.summary.setText('Waiting');
    view.summary.setColor('#f8fafc');
    view.diagnostics.setText('No diagnostics');
    view.summaryText = 'Waiting';
    view.diagnosticsText = 'No diagnostics';
    view.active = false;
  }

  dispose() {
    window.clearTimeout(this.headClearTimeout);
    xb.input.headGestures?.removeEventListener('gesture', this.onHeadGesture);
    const handGestures = xb.core.gestureRecognition;
    handGestures?.removeEventListener('gesturestart', this.onHandGesture);
    handGestures?.removeEventListener('gestureupdate', this.onHandGesture);
    handGestures?.removeEventListener('gestureend', this.onHandGestureEnd);
    this.uiCore.dispose();
  }
}

function formatDiagnostics(data) {
  if (!data) return 'No diagnostics';
  const labels = {
    duration: 'time',
    reversals: 'turns',
    amplitude: 'angle',
    peakAngularSpeed: 'speed',
    openness: 'open',
    horizontalAlignment: 'level',
    verticalAlignment: 'upright',
    translation: 'travel',
  };
  const values = Object.entries(data).map(([key, value]) => {
    const label = labels[key] ?? key;
    const formatted = typeof value === 'number' ? value.toFixed(2) : value;
    return `${label} ${formatted}`;
  });
  const lines = [];
  for (let index = 0; index < values.length; index += 3) {
    lines.push(values.slice(index, index + 3).join('  |  '));
  }
  return lines.join('\n');
}

function formatCompactDiagnostics(data) {
  if (!data) return 'active';
  const values = [];
  if (typeof data.duration === 'number') {
    values.push(`${Math.round(data.duration)} ms`);
  }
  if (typeof data.reversals === 'number') {
    values.push(`${Math.round(data.reversals)} turns`);
  }
  if (typeof data.amplitude === 'number') {
    values.push(`${Math.round(data.amplitude)} deg`);
  }
  if (typeof data.openness === 'number') {
    values.push(`open ${data.openness.toFixed(2)}`);
  }
  if (typeof data.thumbTiltDeviationDegrees === 'number') {
    values.push(
      `thumb offset ${Math.round(data.thumbTiltDeviationDegrees)} deg`
    );
  }
  return values.slice(0, 4).join(' | ') || 'active';
}

function formatGestureName(name) {
  return name.replaceAll('-', ' ').toUpperCase();
}

xb.add(new TemporalGestureHUD());
xb.init(options);
