// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the KnxApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { KnxApp } from './src/app.js';
import { ACTIONS, SCENE_ACTIONS, WIDGETS } from './src/constants.js';

const gladys = new GladysIntegration();
const app = new KnxApp({ gladys });

// --- Discovery and commands ------------------------------------------------------
gladys.onScanRequest(() => app.publishDevices());
gladys.onDeviceCreated((device) => app.deviceCreated(device));
gladys.onDeviceUpdated((device) => app.deviceCreated(device));
gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

// --- Scene actions --------------------------------------------------------------
gladys.onSceneAction(SCENE_ACTIONS.SEND, (fields) => app.sendGroupValue(fields));

// --- Dashboard widget -----------------------------------------------------------
gladys.onWidgetGet(WIDGETS.BUS, (request) => app.getWidget(WIDGETS.BUS, request));

// --- Configuration screen button -------------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testGateway());

// --- Configuration changed by the user ----------------------------------------
// The tunnel stays open when only the device list changed.
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated');
  return app.start(config);
});

// --- Connection lifecycle ------------------------------------------------------
// The KNX tunnel outlives a blip of the Gladys connection: the reconnection
// reloads the configuration and reads the states again, without a new tunnel.
gladys.on('connected', async () => {
  try {
    await app.start(await gladys.getConfig());
  } catch (err) {
    logger.error('Start failed', err);
  }
});
gladys.handleShutdown(() => app.stop());

logger.info('Starting the KNX integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
