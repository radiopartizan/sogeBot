import { evaluate as mathJsEvaluate } from 'mathjs';
import axios, { AxiosResponse } from 'axios';
import safeEval from 'safe-eval';
import querystring from 'querystring';
import _ from 'lodash';
import crypto from 'crypto';
import gitCommitInfo from 'git-commit-info';
import { AllHtmlEntities as Entities} from 'html-entities';

import { debug, error, warning } from './helpers/log';
import { getCountOfCommandUsage } from './helpers/commands/count';
import { getRepository } from 'typeorm';

import { Alias } from './database/entity/alias';
import { Commands } from './database/entity/commands';
import { Cooldown } from './database/entity/cooldown';
import { EventList } from './database/entity/eventList';
import { User, UserInterface } from './database/entity/user';
import { Price } from './database/entity/price';
import { Rank } from './database/entity/rank';

import oauth from './oauth';
import api from './api';
import tmi from './tmi';
import customvariables from './customvariables';
import spotify from './integrations/spotify';
import songs from './systems/songs';
import Parser from './parser';
import { translate } from './translate';
import { getLocalizedName, isIgnored, parserReply, prepare } from './commons';
import currency from './currency';
import points from './systems/points';
import {default as priceSystem} from './systems/price';
import permissions from './permissions';
import users from './users';
import customcommands from './systems/customcommands';


class Message {
  message = '';

  constructor (message: string) {
    this.message = Entities.decode(message);
  }

  async global (opts:any) {
    const variables = {
      game: api.stats.currentGame,
      language: api.stats.language,
      viewers: api.stats.currentViewers,
      views: api.stats.currentViews,
      followers: api.stats.currentFollowers,
      hosts: api.stats.currentHosts,
      subscribers: api.stats.currentSubscribers,
      bits: api.stats.currentBits,
      title: api.stats.currentTitle,
    };
    for (const variable of Object.keys(variables)) {
      const regexp = new RegExp(`\\$${variable}`, 'g');
      this.message = this.message.replace(regexp, String(variables[variable as keyof typeof variables] || ''));
    }

    const version = _.get(process, 'env.npm_package_version', 'x.y.z');
    this.message = this.message.replace(/\$version/g, version.replace('SNAPSHOT', gitCommitInfo().shortHash || 'SNAPSHOT'));

    if (this.message.includes('$latestFollower')) {
      const latestFollower = await getRepository(EventList).createQueryBuilder('events')
        .select('events')
        .orderBy('events.timestamp', 'DESC')
        .where('events.event = :event', { event: 'follow' })
        .getOne();
      this.message = this.message.replace(/\$latestFollower/g, !_.isNil(latestFollower) ? latestFollower.username : 'n/a');
    }

    // latestSubscriber
    if (this.message.includes('$latestSubscriber')) {
      const latestSubscriber = await getRepository(EventList).createQueryBuilder('events')
        .select('events')
        .orderBy('events.timestamp', 'DESC')
        .where('events.event = :event1', { event1: 'sub' })
        .orWhere('events.event = :event2', { event2: 'resub' })
        .orWhere('events.event = :event3', { event3: 'subgift' })
        .getOne();
      this.message = this.message.replace(/\$latestSubscriber/g, !_.isNil(latestSubscriber) ? latestSubscriber.username : 'n/a');
    }

    // latestTip, latestTipAmount, latestTipCurrency, latestTipMessage
    if (this.message.includes('$latestTip')
      || this.message.includes('$latestTipAmount')
      || this.message.includes('$latestTipCurrency')
      || this.message.includes('$latestTipMessage')) {
      const latestTip = await getRepository(EventList).createQueryBuilder('events')
        .select('events')
        .orderBy('events.timestamp', 'DESC')
        .where('events.event = :event', { event: 'tip' })
        .getOne();
      this.message = this.message.replace(/\$latestTipAmount/g, !_.isNil(latestTip) ? parseFloat(JSON.parse(latestTip.values_json).amount).toFixed(2) : 'n/a');
      this.message = this.message.replace(/\$latestTipCurrency/g, !_.isNil(latestTip) ? JSON.parse(latestTip.values_json).currency : 'n/a');
      this.message = this.message.replace(/\$latestTipMessage/g, !_.isNil(latestTip) ? JSON.parse(latestTip.values_json).message : 'n/a');
      this.message = this.message.replace(/\$latestTip/g, !_.isNil(latestTip) ? latestTip.username : 'n/a');
    }

    // latestCheer, latestCheerAmount, latestCheerCurrency, latestCheerMessage
    if (this.message.includes('$latestCheerAmount')
    || this.message.includes('$latestCheerMessage')
    || this.message.includes('$latestCheer')) {
      const latestCheer = await getRepository(EventList).createQueryBuilder('events')
        .select('events')
        .orderBy('events.timestamp', 'DESC')
        .where('events.event = :event', { event: 'cheer' })
        .getOne();
      this.message = this.message.replace(/\$latestCheerAmount/g, !_.isNil(latestCheer) ? JSON.parse(latestCheer.values_json).amount : 'n/a');
      this.message = this.message.replace(/\$latestCheerMessage/g, !_.isNil(latestCheer) ? JSON.parse(latestCheer.values_json).message : 'n/a');
      this.message = this.message.replace(/\$latestCheer/g, !_.isNil(latestCheer) ? latestCheer.username : 'n/a');
    }

    const spotifySong = JSON.parse(spotify.currentSong);
    if (!_.isEmpty(spotifySong) && spotifySong.is_playing && spotifySong.is_enabled) {
      // load spotify format
      const format = spotify.format;
      if (opts.escape) {
        spotifySong.song = spotifySong.song.replace(new RegExp(opts.escape, 'g'), `\\${opts.escape}`);
        spotifySong.artist = spotifySong.artist.replace(new RegExp(opts.escape, 'g'), `\\${opts.escape}`);
      }
      this.message = this.message.replace(/\$spotifySong/g, format.replace(/\$song/g, spotifySong.song).replace(/\$artist/g, spotifySong.artist));
    } else {
      this.message = this.message.replace(/\$spotifySong/g, translate('songs.not-playing'));
    }


    if (songs.enabled
        && this.message.includes('$ytSong')
        && Object.values(songs.isPlaying).find(o => o)) {
      let currentSong = _.get(JSON.parse(await songs.currentSong), 'title', translate('songs.not-playing'));
      if (opts.escape) {
        currentSong = currentSong.replace(new RegExp(opts.escape, 'g'), `\\${opts.escape}`);
      }
      this.message = this.message.replace(/\$ytSong/g, currentSong);
    } else {
      this.message = this.message.replace(/\$ytSong/g, translate('songs.not-playing'));
    }

    return Entities.decode(this.message);
  }

  async parse (attr: { [name: string]: any } = {}) {
    this.message = await this.message; // if is promise

    const random = {
      '(random.online.viewer)': async function () {
        const viewers = (await getRepository(User).createQueryBuilder('user')
          .where('user.username != :botusername', { botusername: oauth.botUsername.toLowerCase() })
          .andWhere('user.username != :broadcasterusername', { broadcasterusername: oauth.broadcasterUsername.toLowerCase() })
          .andWhere('user.isOnline = :isOnline', { isOnline: true })
          .cache(true)
          .getMany())
          .filter(o => {
            return !isIgnored({ username: o.username, userId: o.userId });
          });
        if (viewers.length === 0) {
          return 'unknown';
        }
        return _.sample(viewers.map(o => o.username ));
      },
      '(random.online.follower)': async function () {
        const followers = (await getRepository(User).createQueryBuilder('user')
          .where('user.username != :botusername', { botusername: oauth.botUsername.toLowerCase() })
          .andWhere('user.username != :broadcasterusername', { broadcasterusername: oauth.broadcasterUsername.toLowerCase() })
          .andWhere('user.isFollower = :isFollower', { isFollower: true })
          .andWhere('user.isOnline = :isOnline', { isOnline: true })
          .cache(true)
          .getMany()).filter(o => {
          return !isIgnored({ username: o.username, userId: o.userId });
        });
        if (followers.length === 0) {
          return 'unknown';
        }
        return _.sample(followers.map(o => o.username ));
      },
      '(random.online.subscriber)': async function () {
        const subscribers = (await getRepository(User).createQueryBuilder('user')
          .where('user.username != :botusername', { botusername: oauth.botUsername.toLowerCase() })
          .andWhere('user.username != :broadcasterusername', { broadcasterusername: oauth.broadcasterUsername.toLowerCase() })
          .andWhere('user.isSubscriber = :isSubscriber', { isSubscriber: true })
          .andWhere('user.isOnline = :isOnline', { isOnline: true })
          .cache(true)
          .getMany()).filter(o => {
          return !isIgnored({ username: o.username, userId: o.userId });
        });
        if (subscribers.length === 0) {
          return 'unknown';
        }
        return _.sample(subscribers.map(o => o.username ));
      },
      '(random.viewer)': async function () {
        const viewers = (await getRepository(User).createQueryBuilder('user')
          .where('user.username != :botusername', { botusername: oauth.botUsername.toLowerCase() })
          .andWhere('user.username != :broadcasterusername', { broadcasterusername: oauth.broadcasterUsername.toLowerCase() })
          .cache(true)
          .getMany()).filter(o => {
          return !isIgnored({ username: o.username, userId: o.userId });
        });
        if (viewers.length === 0) {
          return 'unknown';
        }
        return _.sample(viewers.map(o => o.username ));
      },
      '(random.follower)': async function () {
        const followers = (await getRepository(User).createQueryBuilder('user')
          .where('user.username != :botusername', { botusername: oauth.botUsername.toLowerCase() })
          .andWhere('user.username != :broadcasterusername', { broadcasterusername: oauth.broadcasterUsername.toLowerCase() })
          .andWhere('user.isFollower = :isFollower', { isFollower: true })
          .cache(true)
          .getMany()).filter(o => {
          return !isIgnored({ username: o.username, userId: o.userId });
        });
        if (followers.length === 0) {
          return 'unknown';
        }
        return _.sample(followers.map(o => o.username ));
      },
      '(random.subscriber)': async function () {
        const subscribers = (await getRepository(User).createQueryBuilder('user')
          .where('user.username != :botusername', { botusername: oauth.botUsername.toLowerCase() })
          .andWhere('user.username != :broadcasterusername', { broadcasterusername: oauth.broadcasterUsername.toLowerCase() })
          .andWhere('user.isSubscriber = :isSubscriber', { isSubscriber: true })
          .cache(true)
          .getMany()).filter(o => {
          return !isIgnored({ username: o.username, userId: o.userId });
        });
        if (subscribers.length === 0) {
          return 'unknown';
        }
        return _.sample(subscribers.map(o => o.username ));
      },
      '(random.number-#-to-#)': async function (filter: string) {
        const numbers = filter.replace('(random.number-', '')
          .replace(')', '')
          .split('-to-');

        try {
          let lastParamUsed = 0;
          for (const index of numbers) {
            if (!_.isFinite(parseInt(numbers[Number(index)], 10))) {
              const param = attr.param.split(' ');
              if (_.isNil(param[lastParamUsed])) {
                return 0;
              }

              numbers[Number(index)] = param[lastParamUsed];
              lastParamUsed++;
            }
          }
          return _.random(Number(numbers[0]), Number(numbers[1]));
        } catch (e) {
          return 0;
        }
      },
      '(random.true-or-false)': async function () {
        return Math.random() < 0.5;
      },
    };
    const custom = {
      '$_#': async (variable: string) => {
        if (!_.isNil(attr.param) && attr.param.length !== 0) {
          const state = await customvariables.setValueOf(variable, attr.param, { sender: { ...attr.sender, source: typeof attr.sender.discord === 'undefined' ? 'twitch' : 'discord' } });
          if (state.updated.responseType === 0) {
            // default
            if (state.isOk && !state.isEval) {
              const msg = prepare('filters.setVariable', { value: state.setValue, variable: variable });
              parserReply(msg, { sender: attr.sender, attr: { skip: true, quiet: _.get(attr, 'quiet', false) } });
            }
            return state.updated.currentValue;
          } else if (state.updated.responseType === 1) {
            // custom
            if (state.updated.responseText) {
              parserReply(state.updated.responseText.replace('$value', state.setValue), { sender: attr.sender, attr: { skip: true, quiet: _.get(attr, 'quiet', false) }});
            }
            return '';
          } else {
            // command
            return state.isOk && !state.isEval ? state.setValue : state.updated.currentValue;
          }
        }
        return customvariables.getValueOf(variable, {
          sender: { ...attr.sender, source: typeof attr.sender.discord === 'undefined' ? 'twitch' : 'discord' },
          param: attr.param,
        });
      },
      // force quiet variable set
      '$!_#': async (variable: string) => {
        variable = variable.replace('$!_', '$_');
        if (!_.isNil(attr.param) && attr.param.length !== 0) {
          const state = await customvariables.setValueOf(variable, attr.param, { sender: { ...attr.sender, source: typeof attr.sender.discord === 'undefined' ? 'twitch' : 'discord' } });
          return state.updated.currentValue;
        }
        return customvariables.getValueOf(variable, {
          sender: { ...attr.sender, source: typeof attr.sender.discord === 'undefined' ? 'twitch' : 'discord' },
          param: attr.param,
        });
      },
      // force full quiet variable
      '$!!_#': async (variable: string) => {
        variable = variable.replace('$!!_', '$_');
        if (!_.isNil(attr.param) && attr.param.length !== 0) {
          await customvariables.setValueOf(variable, attr.param, { sender: { ...attr.sender, source: typeof attr.sender.discord === 'undefined' ? 'twitch' : 'discord' } });
        }
        return '';
      },
    };
    const param = {
      '$touser': async function () {
        if (typeof attr.param !== 'undefined') {
          attr.param = attr.param.replace('@', '');
          if (attr.param.length > 0) {
            if (tmi.showWithAt) {
              attr.param = '@' + attr.param;
            }
            return attr.param;
          }
        }
        return (tmi.showWithAt ? '@' : '') + attr.sender.username;
      },
      '$param': async function () {
        if (!_.isUndefined(attr.param) && attr.param.length !== 0) {
          return attr.param;
        }
        return '';
      },
      '$!param': async function () {
        if (!_.isUndefined(attr.param) && attr.param.length !== 0) {
          return attr.param;
        }
        return 'n/a';
      },
    };
    const qs = {
      '$querystring': async function () {
        if (!_.isUndefined(attr.param) && attr.param.length !== 0) {
          return querystring.escape(attr.param);
        }
        return '';
      },
      '(url|#)': async function () {
        try {
          return encodeURI(attr.param);
        } catch (e) {
          return '';
        }
      },
    };
    const info = {
      '$toptip.#.#': async function (filter: string) {
        const match = filter.match(/\$toptip\.(?<type>overall|stream)\.(?<value>username|amount|message|currency)/);
        if (!match) {
          return '';
        }

        let tips = (await getRepository(EventList).createQueryBuilder('events')
          .select('events')
          .orderBy('events.timestamp', 'DESC')
          .where('events.event >= :event', { event: 'tip' })
          .getMany())
          .sort((a, b) => {
            const aValue = JSON.parse(a.values_json);
            const bValue = JSON.parse(b.values_json);
            const aTip = currency.exchange(aValue.amount, aValue.currency, currency.mainCurrency);
            const bTip = currency.exchange(bValue.amount, bValue.currency, currency.mainCurrency);
            return bTip - aTip;
          });

        const type = match.groups?.type;
        if (type === 'stream') {
          const whenOnline = api.isStreamOnline ? api.streamStatusChangeSince : null;
          if (whenOnline) {
            tips = tips.filter((o) => o.timestamp >= (new Date(whenOnline)).getTime());
          } else {
            return '';
          }
        }

        if (tips.length > 0) {
          const value = match.groups?.value;
          switch(value) {
            case 'amount':
              return Number(JSON.parse(tips[0].values_json).amount).toFixed(2);
            case 'currency':
              return Number(JSON.parse(tips[0].values_json).currency);
            case 'message':
              return Number(JSON.parse(tips[0].values_json).message);
            case 'username':
              return tips[0].username;
          }
        }
        return '';
      },
      '(game)': async function () {
        return api.stats.currentGame || 'n/a';
      },
      '(status)': async function () {
        return api.stats.currentTitle || 'n/a';
      },
    };
    const command = {
      '$count(\'#\')': async function (filter: string) {
        const countRegex = new RegExp('\\$count\\(\\\'(?<command>\\!\\S*)\\\'\\)', 'gm');
        const match = countRegex.exec(filter);
        if (match && match.groups) {
          return String(await getCountOfCommandUsage(match.groups.command));
        }
        return '0';
      },
      '$count': async function () {
        if (attr.command) {
          return String((await getCountOfCommandUsage(attr.command)));
        }
        return '0';
      },
      '(!!#)': async function (filter: string) {
        const cmd = filter
          .replace('!', '') // replace first !
          .replace(/\(|\)/g, '')
          .replace(/\$param/g, attr.param);
        debug('message.process', cmd);

        // check if we already checked cmd
        if (!attr.processedCommands) {
          attr.processedCommands = [];
        }
        if (attr.processedCommands.includes(cmd)) {
          error(`Response ${filter} seems to be in loop! ${attr.processedCommands.join('->')}->${attr.command}`);
          debug('message.error', `Response ${filter} seems to be in loop! ${attr.processedCommands.join('->')}->${attr.command}`);
          return '';
        } else {
          attr.processedCommands.push(attr.command);
        }

        // run custom commands
        if (customcommands.enabled) {
          await customcommands.run({ sender: (attr.sender as ParserOptions['sender']), id: 'null', skip: false, quiet: true, message: cmd, parameters: attr.param });
        }
        await new Parser().command(attr.sender, cmd, true);
        // we are not sending back any responses!
        return '';
      },
      '(!#)': async (filter: string) => {
        const cmd = filter
          .replace(/\(|\)/g, '')
          .replace(/\$param/g, attr.param);
        debug('message.process', cmd);

        // check if we already checked cmd
        if (!attr.processedCommands) {
          attr.processedCommands = [];
        }
        if (attr.processedCommands.includes(cmd)) {
          error(`Response ${filter} seems to be in loop! ${attr.processedCommands.join('->')}->${attr.command}`);
          debug('message.error', `Response ${filter} seems to be in loop! ${attr.processedCommands.join('->')}->${attr.command}`);
          return '';
        } else {
          attr.processedCommands.push(attr.command);
        }

        // run custom commands
        if (customcommands.enabled) {
          await customcommands.run({ sender: (attr.sender as ParserOptions['sender']), id: 'null', skip: false, message: cmd, parameters: attr.param, processedCommands: attr.processedCommands });
        }
        const responses = await new Parser().command(attr.sender, cmd, true);
        for (let i = 0; i < responses.length; i++) {
          setTimeout(async () => {
            parserReply(await responses[i].response, { sender: responses[i].sender, attr: responses[i].attr });
          }, 500 * i);
        }
        return '';
      },
    };
    const price = {
      '(price)': async function () {
        const cmd = await getRepository(Price).findOne({ command: attr.cmd, enabled: true });
        return [price, await points.getPointsName(cmd?.price ?? 0)].join(' ');
      },
    };
    const online = {
      '(onlineonly)': async function () {
        return api.isStreamOnline;
      },
      '(offlineonly)': async function () {
        return !(api.isStreamOnline);
      },
    };
    const list = {
      '(list.#)': async function (filter: string) {
        const [main, permission] = filter.replace('(list.', '').replace(')', '').split('.');
        let system = main;
        let group: null | string | undefined = undefined;
        if (main.includes('|')) {
          [system, group] = main.split('|');
          if (group.trim().length === 0) {
            group = null;
          }
        }
        let [alias, commands, cooldowns, ranks, prices] = await Promise.all([
          getRepository(Alias).find({ where: typeof group !== 'undefined' ? { visible: true, enabled: true, group } : { visible: true, enabled: true } }),
          getRepository(Commands).find({ relations: ['responses'], where: { visible: true, enabled: true } }),
          getRepository(Cooldown).find({ where: { isEnabled: true } }),
          getRepository(Rank).find(),
          getRepository(Price).find({ where: { enabled: true } }),
        ]);

        let listOutput: any = [];
        switch (system) {
          case 'alias':
            return _.size(alias) === 0 ? ' ' : (_.map(alias, (o) => {
              const findPrice = prices.find(p => p.command === o.alias);
              if (findPrice && priceSystem.enabled) {
                return o.alias.replace('!', '') + `(${findPrice.price} ${points.getPointsName(findPrice.price)})`;
              } else {
                return o.alias.replace('!', '');
              }
            })).sort().join(', ');
          case '!alias':
            return _.size(alias) === 0 ? ' ' : (_.map(alias, (o) => {
              const findPrice = prices.find(p => p.command === o.alias);
              if (findPrice && priceSystem.enabled) {
                return o.alias + `(${findPrice.price} ${points.getPointsName(findPrice.price)})`;
              } else {
                return o.alias;
              }
            })).sort().join(', ');
          case 'core':
          case '!core':
            if (permission) {
              const _permission = await permissions.get(permission);
              if (_permission) {
                const coreCommands = (await Promise.all((await new Parser().getCommandsList()).map(async (item) => {
                  const customPermission = await permissions.getCommandPermission(item.id);
                  return { ...item, permission: typeof customPermission !== 'undefined' ? customPermission : item.permission };
                })))
                  .filter(item => item.permission === _permission.id);
                return coreCommands.length === 0
                  ? ' '
                  : coreCommands.map(item => system === '!core' ? item.command : item.command.replace('!', '')).sort().join(', ');
              } else {
                error(`Permission for (list.core.${permission}) not found.`);
                return '';
              }
            } else {
              error('Missing permission for (list.core.<missing>).');
              return '';
            }
          case 'command':
            if (permission) {
              const responses = commands.map(o => o.responses).flat();
              const _permission = await permissions.get(permission);
              if (_permission) {
                const commandIds = responses.filter((o) => o.permission === _permission.id).map((o) => o.id);
                commands = commands.filter((o) => commandIds.includes(o.id));
              } else {
                commands = [];
              }
            }
            return _.size(commands) === 0 ? ' ' : (_.map(commands, (o) => {
              const findPrice = prices.find(p => p.command === o.command);
              if (findPrice && priceSystem.enabled) {
                return o.command.replace('!', '') + `(${findPrice.price} ${points.getPointsName(findPrice.price)})`;
              } else {
                return o.command.replace('!', '');
              }
            })).sort().join(', ');
          case '!command':
            if (permission) {
              const responses = commands.map(o => o.responses).flat();
              const _permission = await permissions.get(permission);
              if (_permission) {
                const commandIds = responses.filter((o) => o.permission === _permission.id).map((o) => o.id);
                commands = commands.filter((o) => commandIds.includes(o.id));
              } else {
                commands = [];
              }
            }
            return _.size(commands) === 0 ? ' ' : (_.map(commands, (o) => {
              const findPrice = prices.find(p => p.command === o.command);
              if (findPrice && priceSystem.enabled) {
                return o.command + `(${findPrice.price} ${points.getPointsName(findPrice.price)})`;
              } else {
                return o.command;
              }
            })).sort().join(', ');
          case 'cooldown':
            listOutput = _.map(cooldowns, function (o, k) {
              const time = o.miliseconds;
              return o.name + ': ' + (time / 1000) + 's';
            }).sort().join(', ');
            return listOutput.length > 0 ? listOutput : ' ';
          case 'price':
            listOutput = (await Promise.all(
              _.map(prices, async (o) => {
                return `${o.command} (${o.price}${await points.getPointsName(o.price)})`;
              })
            )).join(', ');
            return listOutput.length > 0 ? listOutput : ' ';
          case 'ranks':
            listOutput = _.map(_.orderBy(ranks.filter(o => o.type === 'viewer'), 'value', 'asc'), (o) => {
              return `${o.rank} (${o.value}h)`;
            }).join(', ');
            return listOutput.length > 0 ? listOutput : ' ';
          case 'ranks.follow':
            listOutput = _.map(_.orderBy(ranks.filter(o => o.type === 'follower'), 'value', 'asc'), (o) => {
              return `${o.rank} (${o.value} ${getLocalizedName(o.value, 'core.months')})`;
            }).join(', ');
            return listOutput.length > 0 ? listOutput : ' ';
          case 'ranks.sub':
            listOutput = _.map(_.orderBy(ranks.filter(o => o.type === 'subscriber'), 'value', 'asc'), (o) => {
              return `${o.rank} (${o.value} ${getLocalizedName(o.value, 'core.months')})`;
            }).join(', ');
            return listOutput.length > 0 ? listOutput : ' ';
          default:
            warning('unknown list system ' + system);
            return '';
        }
      },
    };
    const math = {
      '(math.#)': async function (filter: any) {
        let toEvaluate = filter.replace(/\(math./g, '').replace(/\)/g, '');

        // check if custom variables are here
        const regexp = /(\$_\w+)/g;
        const match = toEvaluate.match(regexp);
        if (match) {
          for (const variable of match) {
            const currentValue = await customvariables.getValueOf(variable);
            toEvaluate = toEvaluate.replace(
              variable,
              isNaN(Number(currentValue)) ? 0 : currentValue
            );
          }
        }
        return mathJsEvaluate(toEvaluate);
      },
    };
    const evaluate = {
      '(eval#)': async function (filter: any) {
        let toEvaluate = filter.replace('(eval ', '').slice(0, -1);

        const containUsers = !_.isNil(toEvaluate.match(/users/g));
        const containRandom = !_.isNil(toEvaluate.replace(/Math\.random|_\.random/g, '').match(/random/g));
        const containOnline = !_.isNil(toEvaluate.match(/online/g));
        const containUrl = !_.isNil(toEvaluate.match(/url\(['"](.*?)['"]\)/g));

        const urls: { id: string; response: AxiosResponse<any> }[] = [];
        if (containUrl) {
          for (const match of toEvaluate.match(/url\(['"](.*?)['"]\)/g)) {
            const id = 'url' + crypto.randomBytes(64).toString('hex').slice(0, 5);
            const url = match.replace(/url\(['"]|["']\)/g, '');
            let response = await axios.get(url);
            try {
              response.data = JSON.parse(response.data.toString());
            } catch (e) {
              // JSON failed, treat like string
              response = response.data.toString();
            }
            urls.push({ id, response });
            toEvaluate = toEvaluate.replace(match, `url.${id}`);
          }
        }

        let allUsers: Readonly<Required<UserInterface>>[] = [];
        if (containUsers || containRandom) {
          allUsers = await getRepository(User).find();
        }
        const user = await users.getUserByUsername(attr.sender.username);

        let onlineViewers: Readonly<Required<UserInterface>>[] = [];
        let onlineSubscribers: Readonly<Required<UserInterface>>[] = [];
        let onlineFollowers: Readonly<Required<UserInterface>>[] = [];

        if (containOnline) {
          const viewers = (await getRepository(User).createQueryBuilder('user')
            .where('user.username != :botusername', { botusername: oauth.botUsername.toLowerCase() })
            .andWhere('user.username != :broadcasterusername', { broadcasterusername: oauth.broadcasterUsername.toLowerCase() })
            .andWhere('user.isOnline = :isOnline', { isOnline: true })
            .getMany()).filter(o => {
            return isIgnored({ username: o.username, userId: o.userId });
          });

          onlineViewers = viewers;
          onlineSubscribers = viewers.filter(o => o.isSubscriber);
          onlineFollowers = viewers.filter(o => o.isFollower);
        }

        const randomVar = {
          online: {
            viewer: _.sample(_.map(onlineViewers, 'username')),
            follower: _.sample(_.map(onlineFollowers, 'username')),
            subscriber: _.sample(_.map(onlineSubscribers, 'username')),
          },
          viewer: _.sample(_.map(allUsers, 'username')),
          follower: _.sample(_.map(_.filter(allUsers, (o) => _.get(o, 'is.follower', false)), 'username')),
          subscriber: _.sample(_.map(_.filter(allUsers, (o) => _.get(o, 'is.subscriber', false)), 'username')),
        };
        const is = {
          follower: user.isFollower, subscriber: user.isSubscriber, moderator: user.isModerator, vip: user.isVIP, online: user.isOnline,
        };

        const toEval = `(function evaluation () {  ${toEvaluate} })()`;
        const context: {
          _: typeof _;
          users: typeof allUsers;
          is: typeof is;
          random: typeof randomVar;
          sender: string;
          param: string | null;
          url: {
            [urlId: string]: AxiosResponse<any>
          };
        } = {
          _: _,
          users: allUsers,
          is: is,
          random: randomVar,
          sender: tmi.showWithAt ? `@${attr.sender.username}` : `${attr.sender.username}`,
          param: _.isNil(attr.param) ? null : attr.param,
          url: {},
        };

        if (containUrl) {
          // add urls to context
          for (const url of urls) {
            context.url[url.id] = url.response;
          }
        }

        return (safeEval(toEval, context));
      },
    };
    const ifp = {
      '(if#)': async function (filter: any) {
        // (if $days>2|More than 2 days|Less than 2 days)
        try {
          const toEvaluate = filter
            .replace('(if ', '')
            .slice(0, -1)
            .replace(/\$param|\$!param/g, attr.param); // replace params
          let [check, ifTrue, ifFalse] = toEvaluate.split('|');
          check = check.startsWith('>') || check.startsWith('<') || check.startsWith('=') ? false : check; // force check to false if starts with comparation
          if (_.isNil(ifTrue)) {
            return;
          }
          if (safeEval(check)) {
            return ifTrue;
          }
          return _.isNil(ifFalse) ? '' : ifFalse;
        } catch (e) {
          return '';
        }
      },
    };
    const stream = {
      '(stream|#|game)': async function (filter: any) {
        const channel = filter.replace('(stream|', '').replace('|game)', '');

        const token = await oauth.botAccessToken;
        if (token === '') {
          return 'n/a';
        }

        try {
          let request = await axios.get(`https://api.twitch.tv/helix/search/channels?query=${channel}`, {
            headers: {
              'Authorization': 'Bearer ' + token,
              'Client-ID': oauth.botClientId,
            },
          });
          const channelId = request.data.users[0]._id;
          request = await axios.get(`https://api.twitch.tv/helix/channels?broadcaster_id=${channelId}`, {
            headers: {
              'Authorization': 'Bearer ' + token,
              'Client-ID': oauth.botClientId,
            },
          });
          return request.data.data[0].game_name;
        } catch (e) {
          return 'n/a';
        } // return nothing on error
      },
      '(stream|#|title)': async function (filter: any) {
        const channel = filter.replace('(stream|', '').replace('|title)', '');

        const token = await oauth.botAccessToken;
        if (token === '') {
          return 'n/a';
        }

        try {
          let request = await axios.get(`https://api.twitch.tv/helix/search/channels?query=${channel}`, {
            headers: {
              'Authorization': 'Bearer ' + token,
              'Client-ID': oauth.botClientId,
            },
          });

          const channelId = request.data.users[0]._id;
          request = await axios.get(`https://api.twitch.tv/helix/channels?broadcaster_id=${channelId}`, {
            headers: {
              'Authorization': 'Bearer ' + token,
              'Client-ID': oauth.botClientId,
            },
          });
          // save remaining api calls
          api.calls.bot.remaining = request.headers['ratelimit-remaining'];
          api.calls.bot.refresh = request.headers['ratelimit-reset'];
          return request.data.data[0].title;
        } catch (e) {
          return 'n/a';
        } // return nothing on error
      },
      '(stream|#|viewers)': async function (filter: any) {
        const channel = filter.replace('(stream|', '').replace('|viewers)', '');

        const token = await oauth.botAccessToken;
        if (token === '') {
          return '0';
        }

        try {
          let request = await axios.get(`https://api.twitch.tv/helix/search/channels?query=${channel}`, {
            headers: {
              'Authorization': 'Bearer ' + token,
              'Client-ID': oauth.botClientId,
            },
          });
          const channelId = request.data.data[0].id;
          request = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${channelId}`, {
            headers: {
              'Authorization': 'Bearer ' + token,
              'Client-ID': oauth.botClientId,
            },
          });
          // save remaining api calls
          api.calls.bot.remaining = request.headers['ratelimit-remaining'];
          api.calls.bot.refresh = request.headers['ratelimit-reset'];
          return request.data.data[0].viewer_count;
        } catch (e) {
          return '0';
        } // return nothing on error
      },
    };

    await this.global({});

    await this.parseMessageEach(price);
    await this.parseMessageEach(info);
    await this.parseMessageEach(random);
    await this.parseMessageEach(ifp, false);
    await this.parseMessageVariables(custom);
    await this.parseMessageEval(evaluate);
    await this.parseMessageEach(param, true);
    // local replaces
    if (!_.isNil(attr)) {
      for (let [key, value] of Object.entries(attr)) {
        if (_.includes(['sender'], key)) {
          if (typeof value.username !== 'undefined') {
            value = tmi.showWithAt && attr.forceWithoutAt !== true ? `@${value.username}` : value.username;
          } else {
            value = tmi.showWithAt && attr.forceWithoutAt !== true ? `@${value}` : value;
          }
        }
        this.message = this.message.replace(new RegExp('[$]' + key, 'g'), value);
      }
    }
    await this.parseMessageEach(math);
    await this.parseMessageOnline(online);
    await this.parseMessageCommand(command);
    await this.parseMessageEach(qs, false);
    await this.parseMessageEach(list);
    await this.parseMessageEach(stream);
    await this.parseMessageApi();

    return this.message;
  }

  async parseMessageApi () {
    if (this.message.trim().length === 0) {
      return;
    }

    const rMessage = this.message.match(/\(api\|(http\S+)\)/i);
    if (!_.isNil(rMessage) && !_.isNil(rMessage[1])) {
      this.message = this.message.replace(rMessage[0], '').trim(); // remove api command from message
      const url = rMessage[1].replace(/&amp;/g, '&');
      const response = await axios.get(url);
      if (response.status !== 200) {
        return translate('core.api.error');
      }

      // search for api datas in this.message
      const rData = this.message.match(/\(api\.(?!_response)(\S*?)\)/gi);
      if (_.isNil(rData)) {
        if (_.isObject(response.data)) {
          // Stringify object
          this.message = this.message.replace('(api._response)', JSON.stringify(response.data));
        } else {
          this.message = this.message.replace('(api._response)', response.data.toString().replace(/^"(.*)"/, '$1'));
        }
      } else {
        if (_.isBuffer(response.data)) {
          response.data = JSON.parse(response.data.toString());
        }
        for (const tag of rData) {
          let path = response.data;
          const ids = tag.replace('(api.', '').replace(')', '').split('.');
          _.each(ids, function (id) {
            const isArray = id.match(/(\S+)\[(\d+)\]/i);
            if (isArray) {
              path = path[isArray[1]][isArray[2]];
            } else {
              path = path[id];
            }
          });
          this.message = this.message.replace(tag, !_.isNil(path) ? path : translate('core.api.not-available'));
        }
      }
    }
  }

  async parseMessageCommand (filters: { [filter: string]: (filter: any) => Promise<any> }) {
    if (this.message.trim().length === 0) {
      return;
    }
    for (const key in filters) {
      if (!filters.hasOwnProperty(key)) {
        continue;
      }

      const fnc = filters[key];
      let regexp = _.escapeRegExp(key);

      // we want to handle # as \w - number in regexp
      regexp = regexp.replace(/#/g, '.*?');
      const rMessage = this.message.match((new RegExp('(' + regexp + ')', 'g')));
      if (!_.isNull(rMessage)) {
        for (const bkey in rMessage) {
          this.message = this.message.replace(rMessage[bkey], await fnc(rMessage[bkey])).trim();
        }
      }
    }
  }

  async parseMessageOnline (filters: { [filter: string]: (filter: any) => Promise<any> }) {
    if (this.message.trim().length === 0) {
      return;
    }
    for (const key in filters) {
      if (!filters.hasOwnProperty(key)) {
        continue;
      }

      const fnc = filters[key];
      let regexp = _.escapeRegExp(key);

      // we want to handle # as \w - number in regexp
      regexp = regexp.replace(/#/g, '(\\S+)');
      const rMessage = this.message.match((new RegExp('(' + regexp + ')', 'g')));
      if (!_.isNull(rMessage)) {
        for (const bkey in rMessage) {
          if (!(await fnc(rMessage[bkey]))) {
            this.message = '';
          } else {
            this.message = this.message.replace(rMessage[bkey], '').trim();
          }
        }
      }
    }
  }

  async parseMessageEval (filters: { [filter: string]: (filter: any) => Promise<any> }) {
    if (this.message.trim().length === 0) {
      return;
    }
    for (const key in filters) {
      if (!filters.hasOwnProperty(key)) {
        continue;
      }

      const fnc = filters[key];
      let regexp = _.escapeRegExp(key);

      // we want to handle # as \w - number in regexp
      regexp = regexp.replace(/#/g, '([\\S ]+)');
      const rMessage = this.message.match((new RegExp('(' + regexp + ')', 'g')));
      if (!_.isNull(rMessage)) {
        for (const bkey in rMessage) {
          const newString = await fnc(rMessage[bkey]);
          if (_.isUndefined(newString) || newString.length === 0) {
            this.message = '';
          }
          this.message = this.message.replace(rMessage[bkey], newString).trim();
        }
      }
    }
  }

  async parseMessageVariables (filters: { [filter: string]: (filter: any) => Promise<any> }, removeWhenEmpty = true) {
    if (this.message.trim().length === 0) {
      return;
    }
    for (const key in filters) {
      if (!filters.hasOwnProperty(key)) {
        continue;
      }

      const fnc = filters[key];
      let regexp = _.escapeRegExp(key);

      regexp = regexp.replace(/#/g, '([a-zA-Z0-9_]+)');
      const rMessage = this.message.match((new RegExp('(' + regexp + ')', 'g')));
      if (!_.isNull(rMessage)) {
        for (const bkey in rMessage) {
          const newString = await fnc(rMessage[bkey]);
          if ((_.isNil(newString) || newString.length === 0) && removeWhenEmpty) {
            this.message = '';
          }
          this.message = this.message.replace(rMessage[bkey], newString).trim();
        }
      }
    }
  }

  async parseMessageEach (filters: { [filter: string]: (filter: any) => Promise<any> }, removeWhenEmpty = true) {
    if (this.message.trim().length === 0) {
      return;
    }
    for (const key in filters) {
      if (!filters.hasOwnProperty(key)) {
        continue;
      }

      const fnc = filters[key];
      let regexp = _.escapeRegExp(key);

      if (key.startsWith('$')) {
        regexp = regexp.replace(/#/g, '(\\b.+?\\b)');
      } else {
        regexp = regexp.replace(/#/g, '([\\S ]+?)'); // default behavior for if
      }
      const rMessage = this.message.match((new RegExp('(' + regexp + ')', 'g')));
      if (!_.isNull(rMessage)) {
        for (const bkey in rMessage) {
          const newString = await fnc(rMessage[bkey]);
          if ((_.isNil(newString) || newString.length === 0) && removeWhenEmpty) {
            this.message = '';
          }
          this.message = this.message.replace(rMessage[bkey], newString).trim();
        }
      }
    }
  }
}

export { Message };
export default Message;
