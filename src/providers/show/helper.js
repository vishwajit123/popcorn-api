// Import the neccesary modules.
import asyncq from "async-q";

import Show from "../../models/Show";
import Util from "../../util";
import { trakt } from "../../config/constants";

/** Class for saving shows. */
export default class Helper {

  /**
   * Create an helper object.
   * @param {String} name - The name of the helper.
   */
  constructor(name) {
    /**
     * The name of the torrent provider.
     * @type {String}  The name of the torrent provider.
     */
    this.name = name;

    /**
     * The util object with general functions.
     * @type {Util}
     */
    this._util = new Util();
  };

  /**
   * Update the number of seasons of a given show
   * @param {Show} show - The show to update the number of seasons.
   * @returns {Show} - A newly updated show.
   */
  async _updateNumSeasons(show) {
    const saved = await Show.findOneAndUpdate({
      _id: show._id
    }, show, {
      new: true,
      upsert: true
    }).exec();
    const distinct = await Show.distinct("episodes.season", {
      _id: saved._id
    }).exec();
    saved.num_seasons = distinct.length;
    return await Show.findOneAndUpdate({
      _id: saved._id
    }, saved, {
      new: true,
      upsert: true
    }).exec();
  };

  /**
   * Update the torrents for an existing show.
   * @param {Object} matching - The matching episode of new the show.
   * @param {Object} found - The matching episode existing show.
   * @param {Show} show - The show to merge the episodes to.
   * @param {String} quality - The quality of the torrent.
   * @returns {Show} - A show with merged torrents.
   */
  _updateEpisode(matching, found, show, quality) {
    let index = show.episodes.indexOf(matching);

    if (found.torrents[quality] && matching.torrents[quality]) {
      let update = false;

      if (found.torrents[quality].seeds > matching.torrents[quality].seeds) {
        update = true;
      } else if (matching.torrents[quality].seeds > found.torrents[quality].seeds) {
        update = false;
      } else if (found.torrents[quality].url === matching.torrents[quality].url) {
        update = true;
      }

      if (update) {
        if (quality === "480p") matching.torrents["0"] = found.torrents[quality];
        matching.torrents[quality] = found.torrents[quality];
      }
    } else if (found.torrents[quality] && !matching.torrents[quality]) {
      if (quality === "480p") matching.torrents["0"] = found.torrents[quality];
      matching.torrents[quality] = found.torrents[quality];
    }

    show.episodes.splice(index, 1, matching);
    return show;
  };

  /**
   * Update a given show with it's associated episodes.
   * @param {Show} show - The show to update its episodes.
   * @returns {Show} - A newly updated show.
   */
  async _updateEpisodes(show) {
    try {

      const found = await Show.findOne({
          _id: show._id
        }).exec();
      if (found) {
        console.log(`${this.name}: '${found.title}' is an existing show.`);
        for (let i = 0; i < found.episodes.length; i++) {
          let matching = show.episodes
            .filter(showEpisode => showEpisode.season === found.episodes[i].season)
            .filter(showEpisode => showEpisode.episode === found.episodes[i].episode);

          if (matching.length != 0) {
            show = this._updateEpisode(matching[0], found.episodes[i], show, "480p");
            show = this._updateEpisode(matching[0], found.episodes[i], show, "720p");
            show = this._updateEpisode(matching[0], found.episodes[i], show, "1080p");
          } else {
            show.episodes.push(found.episodes[i]);
          }
        }

        return await this._updateNumSeasons(show);
      } else {
        console.log(`${this.name}: '${show.title}' is a new show!`);
        const newShow = await new Show(show).save();
        return await this._updateNumSeasons(newShow);
      }
    } catch (err) {
      return this._util.onError(err);
    }
  };

  /**
   * Adds one season to a show.
   * @param {Show} show - The show to add the torrents to.
   * @param {Object} episodes - The episodes containing the torrents.
   * @param {Integer} seasonNumber - The season number.
   * @param {String} slug - The slug of the show.
   * @returns {Show} - A new show with seasons.
   */
  async _addSeason(show, episodes, seasonNumber, slug) {
    try {
      seasonNumber = parseInt(seasonNumber);
      if (!isNaN(seasonNumber) && seasonNumber.toString().length <= 2) {
        const season = await trakt.seasons.season({id: slug, season: seasonNumber, extended: "full"});
        for (let episodeData in season) {
          episodeData = season[episodeData];
          if (episodes[seasonNumber] && episodes[seasonNumber][episodeData.number]) {
            const episode = {
              tvdb_id: episodeData.ids["tvdb"],
              season: episodeData.season,
              episode: episodeData.number,
              title: episodeData.title,
              overview: episodeData.overview,
              date_based: false,
              first_aired: new Date(episodeData.first_aired).getTime() / 1000.0,
              watched: {
                watched: false
              },
              torrents: {}
            };

            if (episode.first_aired > show.latest_episode) show.latest_episode = episode.first_aired;

            episode.torrents = episodes[seasonNumber][episodeData.number];
            episode.torrents[0] = episodes[seasonNumber][episodeData.number]["480p"] ? episodes[seasonNumber][episodeData.number]["480p"] : episodes[seasonNumber][episodeData.number]["720p"];
            show.episodes.push(episode);
          }
        }
      }
    } catch (err) {
      return this._util.onError(`Trakt: Could not find any data on: ${err.path || err} with slug: '${slug}'`);
    }
  };

  /**
   * Get info from Trakt and make a new show object.
   * @param {String} slug - The slug to query https://trakt.tv/.
   * @returns {Show} - A new show without the episodes attached.
   */
  async getTraktInfo(slug) {
    try {
      const traktShow = await trakt.shows.summary({id: slug, extended: "full,images"});
      const traktWatchers = await trakt.shows.watching({id: slug});

      let watching = 0;
      if (traktWatchers !== null) watching = traktWatchers.length;

      if (traktShow && traktShow.ids["imdb"]) {
        return {
          _id: traktShow.ids["imdb"],
          imdb_id: traktShow.ids["imdb"],
          tvdb_id: traktShow.ids["tvdb"],
          title: traktShow.title,
          year: traktShow.year,
          slug: traktShow.ids["slug"],
          synopsis: traktShow.overview,
          runtime: traktShow.runtime,
          rating: {
            hated: 100,
            loved: 100,
            votes: traktShow.votes,
            watching: watching,
            percentage: Math.round(traktShow.rating * 10)
          },
          country: traktShow.country,
          network: traktShow.network,
          air_day: traktShow.airs.day,
          air_time: traktShow.airs.time,
          status: traktShow.status,
          num_seasons: 0,
          last_updated: Number(new Date()),
          latest_episode: 0,
          images: {
            banner: traktShow.images.banner.full !== null ? traktShow.images.banner.full : "images/posterholder.png",
            fanart: traktShow.images.fanart.full !== null ? traktShow.images.fanart.full : "images/posterholder.png",
            poster: traktShow.images.poster.full !== null ? traktShow.images.poster.full : "images/posterholder.png"
          },
          genres: traktShow.genres !== null ? traktShow.genres : ["unknown"],
          episodes: []
        };
      }
    } catch (err) {
      return this._util.onError(`Trakt: Could not find any data on: ${err.path || err} with slug: '${slug}'`);
    }
  };

  /**
   * Adds episodes to a show.
   * @param {Show} show - The show to add the torrents to.
   * @param {Object} episodes - The episodes containing the torrents.
   * @param {String} slug - The slug of the show.
   * @returns {Show} - A show with updated torrents.
   */
  async addEpisodes(show, episodes, slug) {
    try {
      await asyncq.each(Object.keys(episodes), seasonNumber => this._addSeason(show, episodes, seasonNumber, slug));
      return await this._updateEpisodes(show);
    } catch (err) {
      return this._util.onError(err);
    }
  };

};
