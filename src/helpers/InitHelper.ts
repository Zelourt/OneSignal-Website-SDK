import bowser from 'bowser';

import AlreadySubscribedError from '../errors/AlreadySubscribedError';
import { InvalidStateError, InvalidStateReason } from '../errors/InvalidStateError';
import PermissionMessageDismissedError from '../errors/PermissionMessageDismissedError';
import Event from '../Event';
import LimitStore from '../LimitStore';
import { NotificationPermission } from '../models/NotificationPermission';
import SdkEnvironment from '../managers/SdkEnvironment';
import { AppConfig } from '../models/AppConfig';
import { WindowEnvironmentKind } from '../models/WindowEnvironmentKind';
import SubscriptionModalHost from '../modules/frames/SubscriptionModalHost';
import Database from '../services/Database';
import { getConsoleStyle, once, isUsingSubscriptionWorkaround, triggerNotificationPermissionChanged } from '../utils';
import MainHelper from './MainHelper';
import SubscriptionHelper from './SubscriptionHelper';
import { SdkInitError, SdkInitErrorKind } from '../errors/SdkInitError';
import OneSignalApiShared from '../OneSignalApiShared';
import { ContextInterface } from '../models/Context';
import { WorkerMessengerCommand } from '../libraries/WorkerMessenger';
import { DynamicResourceLoader } from '../services/DynamicResourceLoader';
import PushPermissionNotGrantedError from '../errors/PushPermissionNotGrantedError';
import { PushDeviceRecord } from '../models/PushDeviceRecord';
import { EmailDeviceRecord } from '../models/EmailDeviceRecord';
import { SubscriptionStrategyKind } from "../models/SubscriptionStrategyKind";
import { IntegrationKind } from '../models/IntegrationKind';
import { Subscription } from "../models/Subscription";
import ProxyFrameHost from '../modules/frames/ProxyFrameHost';
import Log from '../libraries/Log';
import Environment from '../Environment';
import Bell from '../bell/Bell';
import { CustomLink } from '../CustomLink';
import { ServiceWorkerManager } from "../managers/ServiceWorkerManager";
import { OneSignalUtils } from "../utils/OneSignalUtils";
import { SubscriptionStateKind } from '../models/SubscriptionStateKind';
import SubscriptionPopupHost from "../modules/frames/SubscriptionPopupHost";

declare var OneSignal: any;

export interface SessionInitOptions {
  modalPrompt?: boolean;
  __fromRegister?: boolean;
  __fromInit?: boolean;
  autoAccept?: boolean;
}

export default class InitHelper {
  static async storeInitialValues() {
    const isPushEnabled = await OneSignal.privateIsPushNotificationsEnabled();
    const notificationPermission = await OneSignal.privateGetNotificationPermission();
    const isOptedOut = await OneSignal.internalIsOptedOut();
    LimitStore.put('subscription.optedOut', isOptedOut);
    await Database.put('Options', { key: 'isPushEnabled', value: isPushEnabled });
    await Database.put('Options', {
      key: 'notificationPermission',
      value: notificationPermission
    });
  }

  /** Entry method for any environment that sets expiring subscriptions. */
  public static async processExpiringSubscriptions() {
    const context: ContextInterface = OneSignal.context;

    Log.debug("Checking subscription expiration...");
    const isSubscriptionExpiring = await context.subscriptionManager.isSubscriptionExpiring();
    if (!isSubscriptionExpiring) {
      Log.debug("Subscription is not considered expired.");
      return;
    }

    const integrationKind = await SdkEnvironment.getIntegration();
    const windowEnv = SdkEnvironment.getWindowEnv();

    Log.debug("Subscription is considered expiring. Current Integration:", integrationKind);
    switch (integrationKind) {
      /*
        Resubscribe via the service worker.

        For Secure, we can definitely resubscribe via the current page, but for SecureProxy, we
        used to not be able to subscribe for push within secure child frames. The common supported
        and safe way is to resubscribe via the service worker.
       */
      case IntegrationKind.Secure:
        const rawPushSubscription = await context.subscriptionManager.subscribe(SubscriptionStrategyKind.SubscribeNew);
        await context.subscriptionManager.registerSubscription(rawPushSubscription);
        break;
      case IntegrationKind.SecureProxy:
        if (windowEnv === WindowEnvironmentKind.OneSignalProxyFrame) {
          const newSubscription = await new Promise<Subscription>(resolve => {
            context.workerMessenger.once(WorkerMessengerCommand.SubscribeNew, subscription => {
              resolve(Subscription.deserialize(subscription));
            });
            context.workerMessenger.unicast(WorkerMessengerCommand.SubscribeNew, context.appConfig);
          });
          Log.debug("Finished registering brand new subscription:", newSubscription);
        } else {
          const proxyFrame: ProxyFrameHost = OneSignal.proxyFrameHost;
          await proxyFrame.runCommand(OneSignal.POSTMAM_COMMANDS.PROCESS_EXPIRING_SUBSCRIPTIONS);
        }
        break;
      case IntegrationKind.InsecureProxy:
        /*
          We can't really do anything here except remove a value checked by
          isPushNotificationsEnabled to simulate unsubscribing.
         */
        await Database.remove("Ids", "registrationId");
        Log.debug("Unsubscribed expiring HTTP subscription by removing registration ID.");
        break;
    }
  }

  /**
   * This event occurs after init.
   * For HTTPS sites, this event is called after init.
   * For HTTP sites, this event is called after the iFrame is created,
   *    and a message is received from the iFrame signaling cross-origin messaging is ready.
   * @private
   */
  static async onSdkInitialized() {
    const context: ContextInterface = OneSignal.context;

    // Store initial values of notification permission, user ID, and manual subscription status
    // This is done so that the values can be later compared to see if anything changed
    // This is done here for HTTPS, it is done after the call to _addSessionIframe in sessionInit for HTTP sites, since the iframe is needed for communication
    await InitHelper.storeInitialValues();
    await InitHelper.installNativePromptPermissionChangedHook();
    /*
      If the user has already granted permission, the user has previously
      already subscribed. Don't show welcome notifications if the user is
      automatically resubscribed.
    */
    if (await context.permissionManager.getNotificationPermission(context.appConfig.safariWebId) === NotificationPermission.Granted)
      OneSignal.__doNotShowWelcomeNotification = true;

    if (
      navigator.serviceWorker &&
      window.location.protocol === 'https:' &&
      !await SdkEnvironment.isFrameContextInsecure()
    ) {
      try {
        const registration = await ServiceWorkerManager.getRegistration();
        if (registration && registration.active)
          await context.serviceWorkerManager.establishServiceWorkerChannel();
      } catch (e) { 
        Log.error(e);
      }
    }

    // TODO: possibly wrap into Promise.all for parallel execution
    await InitHelper.processExpiringSubscriptions();
    await InitHelper.showNotifyButton();
    await InitHelper.showPromptsFromWebConfigEditor();
    await InitHelper.sendOnSessionUpdate();
    await InitHelper.updateEmailSessionCount();
    await context.cookieSyncer.install();

    await Event.trigger(OneSignal.EVENTS.SDK_INITIALIZED_PUBLIC);
  }

  public static async sendOnSessionUpdate(): Promise<void> {
    // If user has been subscribed before, send the on_session update to our backend on the first page view.

    const context: ContextInterface = OneSignal.context;

    // TODO: Remove after finished testing.
    // Safeguarded by flag for initial testing. Sent as a part of server config.
    if (!context.appConfig.enableOnSession && !OneSignalUtils.isUsingSubscriptionWorkaround()) {
      return;
    }

    if (!context.sessionManager.isFirstPageView()) {
      return;
    }

    const existingUser = await context.subscriptionManager.isAlreadyRegisteredWithOneSignal();
    if (!existingUser) {
      return;
    }

    const notificationType = await MainHelper.getCurrentNotificationType();

    // TODO: Remove after finished testing.
    // Previously the update was sent for HTTP sites only every time untli user is subscribed.
    if (OneSignalUtils.isUsingSubscriptionWorkaround() && notificationType !== SubscriptionStateKind.Subscribed) {
      return;
    }
    const pushDeviceRecord = new PushDeviceRecord();
    pushDeviceRecord.subscriptionState = notificationType;
    try {
      const { deviceId } = await Database.getSubscription();
      // Checked for presence of deviceId in isAlreadyRegisteredWithOneSignal()
      await OneSignalApiShared.updateUserSession(deviceId, pushDeviceRecord);
    } catch(e) {
      Log.error(`Failed to update user session. Error "${e.message}" ${e.stack}`);
    }
  }

  private static async showNotifyButton() {
    if (Environment.isBrowser() && !OneSignal.notifyButton) {
      OneSignal.config.userConfig.notifyButton = OneSignal.config.userConfig.notifyButton || {};
      if (OneSignal.config.userConfig.bell) {
        // If both bell and notifyButton, notifyButton's options take precedence
        OneSignal.config.userConfig.bell = {
          ...OneSignal.config.userConfig.bell,
          ...OneSignal.config.userConfig.notifyButton
        };
        OneSignal.config.userConfig.notifyButton = {
          ...OneSignal.config.userConfig.notifyButton,
          ...OneSignal.config.userConfig.bell
        };
      }

     const displayPredicate: () => boolean = OneSignal.config.userConfig.notifyButton.displayPredicate;
      if (displayPredicate && typeof displayPredicate === 'function') {
        const predicateValue = await Promise.resolve(OneSignal.config.userConfig.notifyButton.displayPredicate());
        if (predicateValue !== false) {
          OneSignal.notifyButton = new Bell(OneSignal.config.userConfig.notifyButton);
          OneSignal.notifyButton.create();
        } else {
          Log.debug('Notify button display predicate returned false so not showing the notify button.');
        }
      } else {
        OneSignal.notifyButton = new Bell(OneSignal.config.userConfig.notifyButton);
        OneSignal.notifyButton.create();
      }
    }
  }

  public static async updateEmailSessionCount() {
    const context: ContextInterface = OneSignal.context;
    /* Both HTTP and HTTPS pages can update email session by API request without origin/push feature restrictions */
    if (context.sessionManager.isFirstPageView()) {
      const emailProfile = await Database.getEmailProfile();
      if (emailProfile.emailId) {
        await OneSignalApiShared.updateUserSession(
          emailProfile.emailId,
          new EmailDeviceRecord(null, emailProfile.emailAuthHash)
        );
      }
    }
  }

  private static async showPromptsFromWebConfigEditor() {
    const config: AppConfig = OneSignal.config;
    if (!(await OneSignal.privateIsPushNotificationsEnabled()) &&
      config.userConfig.promptOptions &&
      config.userConfig.promptOptions.slidedown &&
      config.userConfig.promptOptions.slidedown.autoPrompt &&
      !(await OneSignal.internalIsOptedOut())) {
      await OneSignal.privateShowHttpPrompt();
    }

    if (config.userConfig.promptOptions) {
      await CustomLink.initialize(config.userConfig.promptOptions.customlink);
    }
  }

  static async installNativePromptPermissionChangedHook() {
    if (navigator.permissions && !(bowser.firefox && Number(bowser.version) <= 45)) {
      OneSignal._usingNativePermissionHook = true;
      // If the browser natively supports hooking the subscription prompt permission change event,
      // use it instead of our SDK method
      const permissionStatus = await navigator.permissions.query({ name: 'notifications' });
      permissionStatus.onchange = function() {
        triggerNotificationPermissionChanged();
      };
    }
  }

  static async saveInitOptions() {
    let opPromises: Promise<any>[] = [];
    if (OneSignal.config.userConfig.persistNotification === false) {
      opPromises.push(Database.put('Options', { key: 'persistNotification', value: false }));
    } else {
      if (OneSignal.config.userConfig.persistNotification === true) {
        opPromises.push(Database.put('Options', { key: 'persistNotification', value: 'force' }));
      } else {
        opPromises.push(Database.put('Options', { key: 'persistNotification', value: true }));
      }
    }

    let webhookOptions = OneSignal.config.userConfig.webhooks;
    ['notification.displayed', 'notification.clicked', 'notification.dismissed'].forEach(event => {
      if (webhookOptions && webhookOptions[event]) {
        opPromises.push(Database.put('Options', { key: `webhooks.${event}`, value: webhookOptions[event] }));
      } else {
        opPromises.push(Database.put('Options', { key: `webhooks.${event}`, value: false }));
      }
    });
    if (webhookOptions && webhookOptions.cors) {
      opPromises.push(Database.put('Options', { key: `webhooks.cors`, value: true }));
    } else {
      opPromises.push(Database.put('Options', { key: `webhooks.cors`, value: false }));
    }

    if (OneSignal.config.userConfig.notificationClickHandlerMatch) {
      opPromises.push(
        Database.put('Options', {
          key: 'notificationClickHandlerMatch',
          value: OneSignal.config.userConfig.notificationClickHandlerMatch
        })
      );
    } else {
      opPromises.push(Database.put('Options', { key: 'notificationClickHandlerMatch', value: 'exact' }));
    }

    if (OneSignal.config.userConfig.notificationClickHandlerAction) {
      opPromises.push(
        Database.put('Options', {
          key: 'notificationClickHandlerAction',
          value: OneSignal.config.userConfig.notificationClickHandlerAction
        })
      );
    } else {
      opPromises.push(Database.put('Options', { key: 'notificationClickHandlerAction', value: 'navigate' }));
    }
    return Promise.all(opPromises);
  }

  static async internalInit() {
    Log.debug('Called %cinternalInit()', getConsoleStyle('code'));

    const context: ContextInterface = OneSignal.context;

    // Always check for an updated service worker
    await context.serviceWorkerManager.updateWorker();

    context.sessionManager.incrementPageViewCount();

    if (bowser.safari && OneSignal.config.userConfig.autoRegister === false) {
      Log.debug('On Safari and autoregister is false, skipping sessionInit().');
      // This *seems* to trigger on either Safari's autoregister false or Chrome HTTP
      // Chrome HTTP gets an SDK_INITIALIZED event from the iFrame postMessage, so don't call it here
      Event.trigger(OneSignal.EVENTS.SDK_INITIALIZED);
      return;
    }

    if (OneSignal.config.userConfig.autoRegister === false && !OneSignal.config.subdomain) {
      Log.debug('Skipping internal init. Not auto-registering and no subdomain.');
      /* 3/25: If a user is already registered, re-register them in case the clicked Blocked and then Allow (which immediately invalidates the GCM token as soon as you click Blocked) */
      await Event.trigger(OneSignal.EVENTS.SDK_INITIALIZED);
      const isPushEnabled = await OneSignal.privateIsPushNotificationsEnabled();
      if (isPushEnabled && !isUsingSubscriptionWorkaround()) {
        Log.info(
          'Because the user is already subscribed and has enabled notifications, we will re-register their GCM token.'
        );
        // Resubscribes them, and in case their GCM registration token was invalid, gets a new one
        await SubscriptionHelper.registerForPush();
      }
      return;
    }

    if (document.visibilityState !== 'visible') {
      once(
        document,
        'visibilitychange',
        (_, destroyEventListener) => {
          if (document.visibilityState === 'visible') {
            destroyEventListener();
            InitHelper.sessionInit({ __fromInit: true });
          }
        },
        true
      );
      return;
    }

    await InitHelper.sessionInit({ __fromInit: true });
  }

  // overridingPageTitle: Only for the HTTP Iframe, pass the page title in from the top frame
  static async initSaveState(overridingPageTitle: string) {
    const appId = await MainHelper.getAppId();
    await Database.put('Ids', { type: 'appId', id: appId });
    const initialPageTitle = overridingPageTitle || document.title || 'Notification';
    await Database.put('Options', { key: 'pageTitle', value: initialPageTitle });
    Log.info(`OneSignal: Set pageTitle to be '${initialPageTitle}'.`);
    const config: AppConfig = OneSignal.config;
    await Database.put('Options', { key: 'emailAuthRequired', value: !!config.emailAuthRequired })
  }

  private static async finishSessionInit(options: SessionInitOptions): Promise<void> {
    OneSignal._sessionInitAlreadyRunning = false;
    if (options.__fromInit) {
      await Event.trigger(OneSignal.EVENTS.SDK_INITIALIZED);
    }
  }

  public static async sessionInit(options?: SessionInitOptions): Promise<void> {
    if (!options) {
      options = {} as SessionInitOptions;
    }

    Log.debug(`Called %csessionInit(${JSON.stringify(options)})`, getConsoleStyle('code'));

    if (OneSignal._sessionInitAlreadyRunning) {
      Log.debug('Returning from sessionInit because it has already been called.');
      return;
    }

    OneSignal._sessionInitAlreadyRunning = true;

    const appId: string = OneSignal.context.appConfig.appId;
    if (options.__fromRegister && options.modalPrompt) {
      /* Show the HTTPS fullscreen modal permission message. */
      OneSignal.subscriptionModalHost = new SubscriptionModalHost(appId, options);
      await OneSignal.subscriptionModalHost.load();
      await InitHelper.finishSessionInit(options);
      return;
    }

    if (!isUsingSubscriptionWorkaround()) {
      /*
        Show HTTPS modal prompt.
       */
      if (options.__fromInit && MainHelper.wasHttpsNativePromptDismissed()) {
        Log.debug('OneSignal: Not automatically showing native HTTPS prompt because the user previously dismissed it.');
        await InitHelper.finishSessionInit(options);
        return;
      }

      /* We don't want to resubscribe if the user is opted out, and we can't check on HTTP, because the promise will
      prevent the popup from opening. */
      const isOptedOut = await OneSignal.internalIsOptedOut();
      if (!isOptedOut) {
        /*
        * Chrome 63 on Android permission prompts are permanent without a dismiss option. To avoid
        * permanent blocks, we want to replace sites automatically showing the native browser request
        * with a slide prompt first.
        * Same for Safari 12.1+.
        */
        const showSlidedown = !options.__fromRegister && OneSignal.config.userConfig.autoRegister === true &&
        (
          (bowser.chrome && Number(bowser.version) >= 63 && (bowser.tablet || bowser.mobile)) ||
          (bowser.safari && Number(bowser.version) >= 12.1)
        );
        if (showSlidedown) {
          await InitHelper.finishSessionInit(options);
          OneSignal.privateShowHttpPrompt();
        }
        else {
          await InitHelper.finishSessionInit(options);
          await SubscriptionHelper.registerForPush();
        }
      } else {
        await InitHelper.finishSessionInit(options);
        OneSignal.setSubscription(true);
      }
      return;
    }

    if (OneSignal.config.userConfig.autoRegister !== true)
      Log.debug('OneSignal: Not automatically showing popover because autoRegister is not specifically true.');
    if (MainHelper.isHttpPromptAlreadyShown())
      Log.debug('OneSignal: Not automatically showing popover because it was previously shown in the same session.');

    if (OneSignal.config.userConfig.autoRegister === true && !MainHelper.isHttpPromptAlreadyShown()) {
      await OneSignal.privateShowHttpPrompt().catch((e: Error) => {
        if (
          (e instanceof InvalidStateError &&
            (e as any).reason === InvalidStateReason[InvalidStateReason.RedundantPermissionMessage]) ||
          e instanceof PermissionMessageDismissedError ||
          e instanceof AlreadySubscribedError ||
          e instanceof PushPermissionNotGrantedError
        ) {
          Log.debug('[Prompt Not Showing]', e);
          // Another prompt is being shown, that's okay
        }
        else
          Log.info(e);
      });
    }
    await InitHelper.finishSessionInit(options);
  }

  static async polyfillSafariFetch() {
    // If Safari - add 'fetch' pollyfill if it isn't already added.
    if (bowser.safari && typeof window.fetch == 'undefined') {
      Log.debug('Loading fetch polyfill for Safari..');
      try {
        await new DynamicResourceLoader().loadFetchPolyfill();
        Log.debug('Done loading fetch polyfill.');
      } catch (e) {
        Log.debug('Error loading fetch polyfill:', e);
      }
    }
  }

  static errorIfInitAlreadyCalled() {
    if (OneSignal._initCalled)
      throw new SdkInitError(SdkInitErrorKind.MultipleInitialization);
    OneSignal._initCalled = true;
  }

  public static async loadSubscriptionPopup(options?: any) {
    /**
     * Users may be subscribed to either .onesignal.com or .os.tc. By this time
     * that they are subscribing to the popup, the Proxy Frame has already been
     * loaded and the user's subscription status has been obtained. We can then
     * use the Proxy Frame present now and check its URL to see whether the user
     * is finally subscribed to .onesignal.com or .os.tc.
     */
    OneSignal.subscriptionPopupHost = new SubscriptionPopupHost(OneSignal.proxyFrameHost.url, options);
    await OneSignal.subscriptionPopupHost.load();
  }
}
