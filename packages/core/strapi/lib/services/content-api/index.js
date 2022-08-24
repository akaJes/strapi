'use strict';

const _ = require('lodash');
const permissions = require('./permissions');

/**
 * Creates an handler which check that the permission's action exists in the action registry
 */
const createValidatePermissionHandler =
  (actionProvider) =>
  ({ permission }) => {
    const action = actionProvider.get(permission.action);

    // If the action isn't registered into the action provider, then ignore the permission and warn the user
    if (!action) {
      strapi.log.debug(
        `Unknown action "${permission.action}" supplied when registering a new permission`
      );
      return false;
    }
  };

/**
 * Create a content API container that holds logic, tools and utils. (eg: permissions, ...)
 */
const createContentAPI = (strapi) => {
  // Add providers
  const providers = {
    action: permissions.providers.createActionProvider(),
    condition: permissions.providers.createConditionProvider(),
  };

  const getActionsMap = () => {
    const actionMap = {};

    const isContentApi = (action) => {
      if (!_.has(action, Symbol.for('__type__'))) {
        return false;
      }

      return action[Symbol.for('__type__')].includes('content-api');
    };

    const registerAPIsActions = (apis, source) => {
      _.forEach(apis, (api, apiName) => {
        const controllers = _.reduce(
          api.controllers,
          (acc, controller, controllerName) => {
            const contentApiActions = _.pickBy(controller, isContentApi);

            if (_.isEmpty(contentApiActions)) {
              return acc;
            }

            acc[controllerName] = Object.keys(contentApiActions);

            return acc;
          },
          {}
        );

        if (!_.isEmpty(controllers)) {
          actionMap[`${source}::${apiName}`] = { controllers };
        }
      });
    };

    registerAPIsActions(strapi.api, 'api');
    registerAPIsActions(strapi.plugins, 'plugin');

    return actionMap;
  };

  const registerActions = async () => {
    const actionsMap = getActionsMap();

    // For each API
    for (const [api, value] of Object.entries(actionsMap)) {
      const { controllers } = value;

      // Register controllers methods as actions
      for (const [controller, actions] of Object.entries(controllers)) {
        // Register each action individually
        await Promise.all(
          actions.map((action) => {
            const actionUID = `${api}.${controller}.${action}`;

            return providers.action.register(actionUID, {
              api,
              controller,
              action,
              uid: actionUID,
            });
          })
        );
      }
    }
  };

  // create permission engine
  const engine = permissions
    .createPermissionEngine({ providers })
    .on('before-format::validate.permission', createValidatePermissionHandler(providers.action));

  return {
    permissions: {
      engine,
      providers,
      registerActions,
      getActionsMap,
    },
  };
};

module.exports = createContentAPI;