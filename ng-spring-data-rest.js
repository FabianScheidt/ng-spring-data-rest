/*
 * This file is part of the ng-spring-data-rest project (https://github.com/dhoeppe/ng-spring-data-rest).
 * Copyright (c) 2020 Daniel Höppe.
 *
 * ng-spring-data-rest is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3.
 *
 * ng-spring-data-rest is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with ng-spring-data-rest.  If not, see https://github.com/dhoeppe/ng-spring-data-rest.
 */

'use strict';

// Load dependencies
const path = require('path');
const axios = require('axios').default;
const axiosCookieJarSupport = require('axios-cookiejar-support').default;
const tough = require('tough-cookie');
const qs = require('qs');
const jsonTs = require('json-schema-to-typescript');
const fs = require('fs');
const fsExtra = require('fs-extra');
const mustache = require('mustache');
const _ = require('lodash');

// Declare constants
const REGEXP_TYPESCRIPT_INTERFACE_NAME = /^(export interface )(\w+)( {)$/m;
const REGEXP_TYPESCRIPT_INTERFACE_ATTRIBUTES = /^export interface \w+ {\n((.|\n)*?)}$/m;
const PATH_CLASS_TEMPLATE = path.join(__dirname, './templates/class');
const PATH_SERVICE_TEMPLATE = path.join(__dirname, './templates/service');
const PATH_MODELS_TEMPLATE = path.join(__dirname, './templates/models');
const PATH_SERVICES_TEMPLATE = path.join(__dirname, './templates/services');

// Declare global variables
let axiosInstance = undefined;

/**
 * Entry point to this script, bootstraps the generation process.
 *
 * @param options The command line parameters and further configuration.
 */
function ngSpringDataRest(options) {
    // Axios instance setup
    axiosInstance = axios.create({
                                     baseURL: options.baseURL,
                                     withCredentials: true,
                                     timeout: 10000
                                 });
    axiosCookieJarSupport(axiosInstance);
    axiosInstance.defaults.jar = new tough.CookieJar();
    
    // Mustache setup
    mustache.tags = ['$$@', '@$$'];
    
    doGenerate(options);
}

/**
 * Generates the output classes.
 *
 * @param options The command line parameters and further configuration.
 */
async function doGenerate(options) {
    if (options.authMethod !== 'NONE') {
        try {
            await doLogin(options);
            console.log(`Authenticated as user ${options.username}.`);
        } catch {
            console.error(`Authentication failed.`);
            process.exit(5);
        }
    }
    
    // Collect models to generate files for.
    const entities = await collectEntities();
    console.log('Collected list of entities.');
    
    // Collect JSON schemas.
    const jsonSchemas = await collectSchemas(entities);
    
    // Create output directory.
    fs.mkdirSync(`${options.outputDir}/${options.modelDir}`,
                 {recursive: true});
    fs.mkdirSync(`${options.outputDir}/${options.serviceDir}`,
                 {recursive: true});

    // Empty output directory
    fsExtra.emptyDirSync(`${options.outputDir}/${options.modelDir}`);
    fsExtra.emptyDirSync(`${options.outputDir}/${options.serviceDir}`);
    
    // Process JSON schemas based on configuration.
    preProcessSchemas(jsonSchemas, options);
    
    // Convert each schema to TypeScript classes and services.
    generateTypeScriptFromSchema(jsonSchemas,
                                 entities,
                                 options.outputDir,
                                 options.modelDir,
                                 options.serviceDir);
}

/**
 * Performs the login based on the provided authentication method.
 *
 * @param options The command line options.
 * @returns {Promise} promise for the request.
 */
function doLogin(options) {
    // Login if necessary with the specified method.
    switch (options.authMethod) {
        case 'COOKIE':
            return authenticateWithCookies(options.authEndpoint,
                                           options.username,
                                           options.password);
        case 'OAUTH2':
            return authenticateWithOAuth2(options.oauthFlow,
                                          options.authEndpoint,
                                          options.username,
                                          options.password,
                                          options.clientId,
                                          options.clientPassword)
                .then(response => {
                    axiosInstance.defaults.headers.common['Authorization'] = response.data.access_token;
                })
    }
}

/**
 * Cookie authentication
 *
 * The POST request body equals to the following:
 *
 * {
 *     username: "...",
 *     password: "..."
 * }
 *
 * @param authEndpoint The authentication endpoint URL to use, fully qualified.
 * @param username
 * @param password
 * @returns {Promise} Promise for the POST request to the authentication endpoint.
 */
function authenticateWithCookies(authEndpoint, username, password) {
    return axiosInstance.post(authEndpoint,
                              qs.stringify({
                                               username: username,
                                               password: password
                                           }));
}

/**
 * OAuth2 authentication
 *
 * Currently only supports the PASSWORD flow without scopes.
 *
 * @param flow The authorization flow to use when authenticating.
 * @param authEndpoint The authentication endpoint URL to use, fully qualified.
 * @param username
 * @param password
 * @param client
 * @param clientPassword
 * @returns {Promise} Promise for the POST request to the authentication endpoint.
 */
function authenticateWithOAuth2(flow, authEndpoint, username, password, client, clientPassword) {
    switch (flow) {
        case 'PASSWORD':
            return axiosInstance.post(authEndpoint,
                                      qs.stringify({
                                                       grant_type: 'password',
                                                       username: username,
                                                       password: password,
                                                       client_id: client,
                                                       client_secret: clientPassword
                                                   }),
                                      {
                                          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                                          auth: {
                                              username: client,
                                              password: clientPassword
                                          }
                                      });
    }
}

/**
 * Retrieves an array of repository endpoints provided by Spring Data REST using the
 * <host>/<basePath>/profile endpoints.
 *
 * @returns {Promise<[]>} Promise for an array of objects containing the repository name and href.
 */
function collectEntities() {
    return axiosInstance.get('profile')
        .then(response => {
            if (!('_links' in response.data)) {
                console.error(
                    'Response does not contain _links element. Could not collect entities.');
                process.exit(4);
            }
            
            return Object.keys(response.data._links)
                .filter(k => k !== 'self')
                .map(k => ({
                    name: k,
                    href: response.data._links[k].href
                }));
        })
        .catch(() => {
            console.error('Collecting entities failed.');
            process.exit(3);
        });
}

/**
 * Retrieves the JSON schema provided by Spring Data REST for each of the entities in the given array.
 *
 * @param entities An array containing the name and href of each profile in Spring Data REST.
 * @returns {Promise<[]>} Promise for an array of JSON schemas.
 */
async function collectSchemas(entities) {
    const schemas = [];
    console.log('Collecting schemas.');
    
    for (const entity of entities) {
        await axiosInstance.get(entity.href, {headers: {'Accept': 'application/schema+json'}})
            .then(response => {
                schemas.push(response.data);
            })
            .catch(() => {
                console.error(`Could not collect schema for '${entity.name}'.`);
                process.exit(4);
            });
    }
    
    return schemas;
}

/**
 * Pre-Processes schemas according to the given configuration.
 *
 * @param schemas
 * @param config
 */
function preProcessSchemas(schemas, config) {
    for (const schema of schemas) {
        if (config.noAdditionalProperties) {
            schema.additionalProperties = false;
        }
        if (config.noTrivialTypes) {
            removeTrivialTitles(schema.properties || {});
            removeTrivialTitles(schema.definitions || {});
        }
    }
}

/**
 * Remove the title properties from object attributes that do not have a $ref property set.
 * This causes json-schema-to-typescript not to generate aliases for trivial types like string, number or boolean.
 *
 * @param object
 */
function removeTrivialTitles(object) {
    for (const key of Object.keys(object)) {
        const property = object[key];
        if (!property['$ref']) {
            delete property.title;
        }
        if (property.properties) {
            removeTrivialTitles(property.properties);
        }
    }
}

/**
 * In order to generate proper class definitions, we need to resolve string attributes with the
 * format "uri" to their referenced entity. Since the JSON schema includes no info which entity
 * is referenced, we need to use the alps description that Spring Data REST provides. This method
 * fetches the alps description for the provieded schema and replaces occurrences of type "string"
 * and format "uri" with type "object" and assigns the title of the referenced schema
 *
 * Note: This is probably not a good way to do this, as it assues both descriptions to be available.
 * There are many reasons why this could break, but it seems to work fine for now...
 *
 * @param entity Entity to be processed
 * @param schema Schema to be processed. The schema will be modified in place
 * @param entities List of all entities
 * @param schemas List of all schemas
 * @returns {Promise<T>} Promise for an array of referenced schemas.
 */
async function resolveUrlStringReferences(entity, schema, entities, schemas) {
    console.log('Collecting schema references.');

    return axiosInstance.get(entity.href, {headers: {'Accept': 'application/alps+json'}})
        .then(response => {
            // Extract the entity descriptors for the current entity from the alps description
            const descriptors = response.data.alps.descriptors;
            const entityDescriptors = descriptors.find(d => d.href === entity.href).descriptors;

            // Find which properties need to be modified
            const properties = schema.properties;
            const relevantPropertyNames = Object.keys(schema.properties)
                .filter(k => properties[k].type === 'string' && properties[k].format === 'uri');

            // Keep track of schemas that are referenced by the properties
            const referencedSchemas = [];

            // Now change the relevant properties
            relevantPropertyNames.forEach(k => {
                const property = properties[k];

                // Change the type to be object and remove the format
                property.type = 'object';
                delete property.format;

                // Find the referenced entity and map it to one of the known entities
                let referencedHref = entityDescriptors.find(d => d.name === k).rt;
                referencedHref = referencedHref.substr(0, referencedHref.lastIndexOf('#'));
                const referencedEntity = entities.find(e => e.href === referencedHref);
                const referencedSchema = schemas[entities.indexOf(referencedEntity)];
                property.title = referencedSchema.title;

                if (referencedSchema !== schema) {
                    referencedSchemas.push(referencedSchema);
                }
            });
            return referencedSchemas;
        })
        .catch((e) => {
            console.error(`Could not collect schema references for '${entity.name}'.`);
            process.exit(4);
        });
}

/**
 * Generates TypeScript classes in the 'model' directory from the given JSON schemas.
 *
 * @param schemas The JSON schemas to convert.
 * @param entities The array of entities, must match the schemas array.
 * @param outputDir The output directory to use. Models are generated in the 'model' subdirectory.
 * @param modelDir The name of the model directory.
 * @param serviceDir The name of the service directory.
 */
async function generateTypeScriptFromSchema(schemas, entities, outputDir, modelDir, serviceDir) {
    console.log(`Generating files.`);
    
    const classTemplateString = fs.readFileSync(PATH_CLASS_TEMPLATE).toString();
    const serviceTemplateString = fs.readFileSync(PATH_SERVICE_TEMPLATE).toString();
    const modelsTemplateString = fs.readFileSync(PATH_MODELS_TEMPLATE).toString();
    const servicesTemplateString = fs.readFileSync(PATH_SERVICES_TEMPLATE).toString();
    const modelsTemplateData = { 'models': [] };
    const servicesTemplateData = { 'services': [] };

    for (let index = 0; index < schemas.length; index++) {
        const schema = schemas[index];
        const entity = entities[index];

        // Apply json-schema-to-typescript conversion.
        let interfaceDefinition = await jsonTs.compile(schema, schema.title, { bannerComment: null });

        // Add I to the beginning of each class name to indicate interface.
        interfaceDefinition = interfaceDefinition.replace(REGEXP_TYPESCRIPT_INTERFACE_NAME, '$1$2Dto$3');

        // Construct filename for generated interface file.
        let matches = interfaceDefinition.match(REGEXP_TYPESCRIPT_INTERFACE_NAME);

        const interfaceName = matches[2];
        const className = interfaceName.substr(0, interfaceName.length - 3);
        const classNameKebab = _.kebabCase(className);

        // Resolve string references to classes and build a definition of the class
        const referencedSchemas = await resolveUrlStringReferences(entity, schema, entities, schemas);
        const referencedClasses = referencedSchemas.map(s => s.title);
        const options = { bannerComment: null, declareExternallyReferenced: false };
        let classDefinition = await jsonTs.compile(schema, schema.title, options);

        // Extract the attributes from the generated class file
        matches = classDefinition.match(REGEXP_TYPESCRIPT_INTERFACE_ATTRIBUTES);
        const classAttributes = matches[1];

        // Create class from template file.
        const classTemplateData = {
            'interfaceDefinition': interfaceDefinition,
            'className': className,
            'classAttributes': classAttributes,
            'referencesOtherClasses': referencedClasses.length > 0,
            'referencedClasses': referencedClasses.join(', ')
        };
        const renderedClass = mustache.render(classTemplateString,
                                              classTemplateData);
        const classFileName = `${classNameKebab}.ts`;
        fs.writeFileSync(`${outputDir}/${modelDir}/${classFileName}`,
                         renderedClass);

        // Create service from template file.
        const serviceTemplateData = {
            'className': className,
            'classNameKebab': classNameKebab,
            'modelDir': modelDir,
            'repositoryName': entity.name
        };
        const renderedService = mustache.render(serviceTemplateString,
                                                serviceTemplateData);
        const serviceFileName = `${classNameKebab}.service.ts`;
        fs.writeFileSync(`${outputDir}/${serviceDir}/${serviceFileName}`,
                         renderedService);
    
        // Append to models and services list
        modelsTemplateData.models.push({
                                           'modelClass': interfaceName,
                                           'modelDir': modelDir,
                                           'modelFile': classNameKebab
                                       });
        modelsTemplateData.models.push({
                                           'modelClass': className,
                                           'modelDir': modelDir,
                                           'modelFile': classNameKebab
                                       });
        servicesTemplateData.services.push({
                                               'modelClass': className,
                                               'serviceDir': serviceDir,
                                               'modelFile': classNameKebab
                                           });
    }

    // Render list of models and services
    const renderedModel = mustache.render(modelsTemplateString, modelsTemplateData);
    fs.writeFileSync(`${outputDir}/${modelDir}.ts`, renderedModel);
    const renderedServices = mustache.render(servicesTemplateString, servicesTemplateData);
    fs.writeFileSync(`${outputDir}/${serviceDir}.ts`, renderedServices);
}

module.exports = ngSpringDataRest;
