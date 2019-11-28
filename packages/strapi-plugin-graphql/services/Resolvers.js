'use strict';

/**
 * GraphQL.js service
 *
 * @description: A set of functions similar to controller's actions to avoid code duplication.
 */

const _ = require('lodash');
const graphql = require('graphql');

const Aggregator = require('./Aggregator');
const Query = require('./Query.js');
const Mutation = require('./Mutation.js');
const Types = require('./Types.js');
const Schema = require('./Schema.js');
const { toSingular, toPlural } = require('./naming');

const convertAttributes = (attributes, globalId) => {
  return Object.keys(attributes)
    .filter(attribute => attributes[attribute].private !== true)
    .reduce((acc, attribute) => {
      // Convert our type to the GraphQL type.
      acc[attribute] = Types.convertType({
        definition: attributes[attribute],
        modelName: globalId,
        attributeName: attribute,
      });
      return acc;
    }, {});
};

const generateEnumDefinitions = (attributes, globalId) => {
  return Object.keys(attributes)
    .filter(attribute => attributes[attribute].type === 'enumeration')
    .map(attribute => {
      const definition = attributes[attribute];

      const name = Types.convertEnumType(definition, globalId, attribute);
      const values = definition.enum.map(v => `\t${v}`).join('\n');
      return `enum ${name} {\n${values}\n}\n`;
    })
    .join('');
};

const generateDynamicZoneDefinitions = (attributes, globalId, schema) => {
  Object.keys(attributes)
    .filter(attribute => attributes[attribute].type === 'dynamiczone')
    .forEach(attribute => {
      const { components } = attributes[attribute];

      const typeName = `${globalId}${_.upperFirst(
        _.camelCase(attribute)
      )}DynamicZone`;

      if (components.length === 0) {
        // Create dummy type because graphql doesn't support empty ones
        // TODO: do sth
      }

      const componentsTypeNames = components.map(componentUID => {
        const compo = strapi.components[componentUID];
        if (!compo) {
          throw new Error(
            `Trying to creating dynamiczone type with unkown component ${componentUID}`
          );
        }

        return compo.globalId;
      });

      const unionType = `union ${typeName} = ${componentsTypeNames.join(
        ' | '
      )}`;

      const inputTypeName = `${typeName}Input`;

      schema.definition += `\n${unionType}\nscalar ${inputTypeName}\n`;

      schema.resolvers[typeName] = {
        __resolveType(obj) {
          return strapi.components[obj.__component].globalId;
        },
      };

      function parseObject(ast, variables) {
        const value = Object.create(null);
        ast.fields.forEach(field => {
          // eslint-disable-next-line no-use-before-define
          value[field.name.value] = parseLiteral(field.value, variables);
        });

        return value;
      }

      function parseLiteral(ast, variables) {
        switch (ast.kind) {
          case graphql.Kind.STRING:
          case graphql.Kind.BOOLEAN:
            return ast.value;
          case graphql.Kind.INT:
          case graphql.Kind.FLOAT:
            return parseFloat(ast.value);
          case graphql.Kind.OBJECT:
            return parseObject(ast, variables);
          case graphql.Kind.LIST:
            return ast.values.map(n => parseLiteral(n, variables));
          case graphql.Kind.NULL:
            return null;
          case graphql.Kind.VARIABLE: {
            const name = ast.name.value;
            return variables ? variables[name] : undefined;
          }
          default:
            return undefined;
        }
      }

      schema.resolvers[inputTypeName] = new graphql.GraphQLScalarType({
        name: inputTypeName,
        description: `Input type for dynamic zone ${attribute} of ${globalId}`,
        serialize: value => value,
        parseValue: value => {
          const compo = Object.values(strapi.components).find(
            compo => compo.globalId === value.__typename
          );

          if (!compo) return undefined;

          const finalValue = {
            __component: compo.uid,
            ..._.omit(value, ['__typename']),
          };

          return finalValue;
        },
        parseLiteral: (ast, variables) => {
          if (ast.kind !== graphql.Kind.OBJECT) return undefined;

          const value = parseObject(ast, variables);

          const compo = Object.values(strapi.components).find(
            compo => compo.globalId === value.__typename
          );

          if (!compo) return undefined;

          const finalValue = {
            __component: compo.uid,
            ..._.omit(value, ['__typename']),
          };

          return finalValue;
        },
      });
    });
};

const mutateAssocAttributes = (associations = [], attributes) => {
  associations
    .filter(association => association.type === 'collection')
    .forEach(association => {
      attributes[
        `${association.alias}(sort: String, limit: Int, start: Int, where: JSON)`
      ] = attributes[association.alias];

      delete attributes[association.alias];
    });
};

const buildAssocResolvers = (model, name, { plugin }) => {
  const contentManager =
    strapi.plugins['content-manager'].services['contentmanager'];

  const { primaryKey, associations = [] } = model;

  return associations
    .filter(association => model.attributes[association.alias].private !== true)
    .reduce((resolver, association) => {
      switch (association.nature) {
        case 'oneToManyMorph': {
          resolver[association.alias] = async obj => {
            const entry = await contentManager.fetch(
              {
                id: obj[primaryKey],
                model: name,
              },
              plugin,
              [association.alias]
            );

            // Set the _type only when the value is defined
            if (entry[association.alias]) {
              entry[association.alias]._type = _.upperFirst(association.model);
            }

            return entry[association.alias];
          };
          break;
        }
        case 'manyMorphToOne':
        case 'manyMorphToMany':
        case 'manyToManyMorph': {
          resolver[association.alias] = async obj => {
            // eslint-disable-line no-unused-vars
            const [withRelated, withoutRelated] = await Promise.all([
              contentManager.fetch(
                {
                  id: obj[primaryKey],
                  model: name,
                },
                plugin,
                [association.alias],
                false
              ),
              contentManager.fetch(
                {
                  id: obj[primaryKey],
                  model: name,
                },
                plugin,
                []
              ),
            ]);

            const entry =
              withRelated && withRelated.toJSON
                ? withRelated.toJSON()
                : withRelated;

            entry[association.alias].map((entry, index) => {
              const type =
                _.get(withoutRelated, `${association.alias}.${index}.kind`) ||
                _.upperFirst(
                  _.camelCase(
                    _.get(
                      withoutRelated,
                      `${association.alias}.${index}.${association.alias}_type`
                    )
                  )
                ) ||
                _.upperFirst(_.camelCase(association[association.type]));

              entry._type = type;

              return entry;
            });

            return entry[association.alias];
          };
          break;
        }

        default: {
          resolver[association.alias] = async (obj, options) => {
            // Construct parameters object to retrieve the correct related entries.
            const params = {
              model: association.model || association.collection,
            };

            let queryOpts = {
              source: association.plugin,
            };

            // Get refering model.
            const ref = association.plugin
              ? strapi.plugins[association.plugin].models[params.model]
              : strapi.models[params.model];

            if (association.type === 'model') {
              params[ref.primaryKey] = _.get(
                obj,
                [association.alias, ref.primaryKey],
                obj[association.alias]
              );
            } else {
              const queryParams = Query.amountLimiting(options);
              queryOpts = {
                ...queryOpts,
                ...Query.convertToParams(_.omit(queryParams, 'where')), // Convert filters (sort, limit and start/skip)
                ...Query.convertToQuery(queryParams.where),
              };

              if (
                ((association.nature === 'manyToMany' &&
                  association.dominant) ||
                  association.nature === 'manyWay') &&
                _.has(obj, association.alias) // if populated
              ) {
                _.set(
                  queryOpts,
                  ['query', ref.primaryKey],
                  obj[association.alias]
                    ? obj[association.alias]
                        .map(val => val[ref.primaryKey] || val)
                        .sort()
                    : []
                );
              } else {
                _.set(
                  queryOpts,
                  ['query', association.via],
                  obj[ref.primaryKey]
                );
              }
            }

            const loaderName = association.plugin
              ? `${association.plugin}__${params.model}`
              : params.model;

            return association.model
              ? strapi.plugins.graphql.services.loaders.loaders[
                  loaderName
                ].load({
                  params,
                  options: queryOpts,
                  single: true,
                })
              : strapi.plugins.graphql.services.loaders.loaders[
                  loaderName
                ].load({
                  options: queryOpts,
                  association,
                });
          };
          break;
        }
      }

      return resolver;
    }, {});
};

const buildModel = (
  model,
  name,
  { schema, plugin, isComponent = false } = {}
) => {
  const { globalId, primaryKey } = model;

  schema.resolvers[globalId] = {
    id: obj => obj[primaryKey],
    ...buildAssocResolvers(model, name, { plugin }),
  };

  const initialState = {
    id: 'ID!',
    [primaryKey]: 'ID!',
  };

  if (_.isArray(_.get(model, 'options.timestamps'))) {
    const [createdAtKey, updatedAtKey] = model.options.timestamps;
    initialState[createdAtKey] = 'DateTime!';
    initialState[updatedAtKey] = 'DateTime!';
  }

  const attributes = convertAttributes(model.attributes, globalId);
  mutateAssocAttributes(model.associations, attributes);
  _.merge(attributes, initialState);

  schema.definition += generateEnumDefinitions(model.attributes, globalId);
  generateDynamicZoneDefinitions(model.attributes, globalId, schema);

  const description = Schema.getDescription({}, model);
  const fields = Schema.formatGQL(attributes, {}, model);
  const typeDef = `${description}type ${globalId} {${fields}}\n`;

  schema.definition += typeDef;
  schema.definition += Types.generateInputModel(model, globalId, {
    allowIds: isComponent,
  });
};

/**
 * Construct the GraphQL query & definition and apply the right resolvers.
 *
 * @return Object
 */

const buildShadowCRUD = (models, plugin) => {
  const initialState = {
    definition: '',
    query: {},
    mutation: {},
    resolvers: { Query: {}, Mutation: {} },
  };

  if (_.isEmpty(models)) {
    return initialState;
  }

  return Object.keys(models).reduce((acc, name) => {
    const model = models[name];

    const { globalId, primaryKey } = model;

    // Setup initial state with default attribute that should be displayed
    // but these attributes are not properly defined in the models.
    const initialState = {
      [primaryKey]: 'ID!',
    };

    // always add an id field to make the api database agnostic
    if (primaryKey !== 'id') {
      initialState['id'] = 'ID!';
    }

    acc.resolvers[globalId] = {
      // define the default id resolver
      id(parent) {
        return parent[model.primaryKey];
      },
    };

    // Add timestamps attributes.
    if (_.isArray(_.get(model, 'options.timestamps'))) {
      const [createdAtKey, updatedAtKey] = model.options.timestamps;
      initialState[createdAtKey] = 'DateTime!';
      initialState[updatedAtKey] = 'DateTime!';
    }

    const _schema = _.cloneDeep(
      _.get(strapi.plugins, 'graphql.config._schema.graphql', {})
    );

    const { type = {}, resolver = {} } = _schema;

    // Convert our layer Model to the GraphQL DL.
    const attributes = convertAttributes(model.attributes, globalId);
    mutateAssocAttributes(model.associations, attributes);
    _.merge(attributes, initialState);

    acc.definition += generateEnumDefinitions(model.attributes, globalId);
    generateDynamicZoneDefinitions(model.attributes, globalId, acc);

    const description = Schema.getDescription(type[globalId], model);
    const fields = Schema.formatGQL(attributes, type[globalId], model);
    const typeDef = `${description}type ${globalId} {${fields}}\n`;

    acc.definition += typeDef;

    // Add definition to the schema but this type won't be "queriable" or "mutable".
    if (
      type[model.globalId] === false ||
      _.get(type, `${model.globalId}.enabled`) === false
    ) {
      return acc;
    }

    const singularName = toSingular(name);
    const pluralName = toPlural(name);
    // Build resolvers.
    const queries = {
      singular:
        _.get(resolver, `Query.${singularName}`) !== false
          ? Query.composeQueryResolver({
              _schema,
              plugin,
              name,
              isSingular: true,
            })
          : null,
      plural:
        _.get(resolver, `Query.${pluralName}`) !== false
          ? Query.composeQueryResolver({
              _schema,
              plugin,
              name,
              isSingular: false,
            })
          : null,
    };

    // check if errors
    Object.keys(queries).forEach(type => {
      // The query cannot be built.
      if (_.isError(queries[type])) {
        strapi.log.error(queries[type]);
        strapi.stop();
      }
    });

    if (_.isFunction(queries.singular)) {
      _.merge(acc, {
        query: {
          [`${singularName}(id: ID!)`]: model.globalId,
        },
        resolvers: {
          Query: {
            [singularName]: queries.singular,
          },
        },
      });
    }

    if (_.isFunction(queries.plural)) {
      _.merge(acc, {
        query: {
          [`${pluralName}(sort: String, limit: Int, start: Int, where: JSON)`]: `[${model.globalId}]`,
        },
        resolvers: {
          Query: {
            [pluralName]: queries.plural,
          },
        },
      });
    }

    // TODO:
    // - Implement batch methods (need to update the content-manager as well).
    // - Implement nested transactional methods (create/update).
    const capitalizedName = _.upperFirst(singularName);
    const mutations = {
      create:
        _.get(resolver, `Mutation.create${capitalizedName}`) !== false
          ? Mutation.composeMutationResolver({
              _schema,
              plugin,
              name,
              action: 'create',
            })
          : null,
      update:
        _.get(resolver, `Mutation.update${capitalizedName}`) !== false
          ? Mutation.composeMutationResolver({
              _schema,
              plugin,
              name,
              action: 'update',
            })
          : null,
      delete:
        _.get(resolver, `Mutation.delete${capitalizedName}`) !== false
          ? Mutation.composeMutationResolver({
              _schema,
              plugin,
              name,
              action: 'delete',
            })
          : null,
    };

    // Add model Input definition.
    acc.definition += Types.generateInputModel(model, name);

    Object.keys(mutations).forEach(type => {
      if (_.isFunction(mutations[type])) {
        let mutationDefinition;
        let mutationName = `${type}${capitalizedName}`;

        // Generate the Input for this specific action.
        acc.definition += Types.generateInputPayloadArguments(
          model,
          name,
          type
        );

        switch (type) {
          case 'create':
            mutationDefinition = {
              [`${mutationName}(input: ${mutationName}Input)`]: `${mutationName}Payload`,
            };

            break;
          case 'update':
            mutationDefinition = {
              [`${mutationName}(input: ${mutationName}Input)`]: `${mutationName}Payload`,
            };

            break;
          case 'delete':
            mutationDefinition = {
              [`${mutationName}(input: ${mutationName}Input)`]: `${mutationName}Payload`,
            };
            break;
          default:
          // Nothing.
        }

        // Assign mutation definition to global definition.
        _.merge(acc, {
          mutation: mutationDefinition,
          resolvers: {
            Mutation: {
              [`${mutationName}`]: mutations[type],
            },
          },
        });
      }
    });

    // TODO: Add support for Graphql Aggregation in Bookshelf ORM
    if (model.orm === 'mongoose') {
      // Generation the aggregation for the given model
      const modelAggregator = Aggregator.formatModelConnectionsGQL(
        attributes,
        model,
        name,
        queries.plural
      );
      if (modelAggregator) {
        acc.definition += modelAggregator.type;
        if (!acc.resolvers[modelAggregator.globalId]) {
          acc.resolvers[modelAggregator.globalId] = {};
        }

        _.merge(acc.resolvers, modelAggregator.resolver);
        _.merge(acc.query, modelAggregator.query);
      }
    }

    // Build associations queries.
    acc.resolvers[globalId] = buildAssocResolvers(model, name, { plugin });

    return acc;
  }, initialState);
};

module.exports = {
  buildShadowCRUD,
  buildModel,
};
