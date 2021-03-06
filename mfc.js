const Promise = require("bluebird");
const mfc     = require("MFCAuto");
const site    = require("./site");
const _       = require("underscore");
const colors  = require("colors/safe");

class Mfc extends site.Site {
    constructor(config, tui) {
        super("MFC", config, "_mfc", tui);
        mfc.setLogLevel(0);
        this.mfcGuest = new mfc.Client("guest", "guest", {useWebSockets: this.siteConfig.mfcWebSocket, camYou: false});
    }

    connect() {
        return Promise.try(() => this.mfcGuest.connectAndWaitForModels()).catch((err) => {
            this.errMsg(err.toString());
        });
    }

    disconnect() {
        this.mfcGuest.disconnect();
    }

    updateList(nm, add, isTemp) {
        // Fetch the UID. The streamer does not have to be online for this.
        return this.mfcGuest.queryUser(nm).then((streamer) => super.updateList(streamer, add, isTemp));
    }

    updateStreamers(bundle, add) {
        const queries = [];
        const list = add ? bundle.includeStreamers : bundle.excludeStreamers;

        for (let i = 0; i < list.length; i++) {
            this.dbgMsg("Checking if " + colors.name(list[i]) + " exists.");
            queries.push(this.updateList(list[i], add, false).then((dirty) => {
                bundle.dirty |= dirty;
            }));
        }

        return Promise.all(queries).then(() => bundle);
    }

    checkStreamerState(uid) {
        return Promise.try(() => this.mfcGuest.queryUser(uid)).then((model) => {
            if (typeof model === "undefined" || typeof model.uid === "undefined") {
                return true;
            }

            let isStreaming = 0;
            let msg = colors.name(model.nm);

            if (!this.streamerList.has(uid)) {
                this.streamerList.set(uid, {uid: uid, nm: model.nm, state: "Offline", filename: "", captureProcess: null, postProcess: 0});
            }

            const streamer = this.streamerList.get(uid);
            const prevState = streamer.state;

            const bestSession = mfc.Model.getModel(model.uid).bestSession;

            if (bestSession.vs === mfc.STATE.FreeChat) {
                streamer.state = "Public Chat";
                msg += " is in public chat!";
                this.streamersToCap.push(model);
                isStreaming = 1;
            } else if (bestSession.vs === mfc.STATE.GroupShow) {
                streamer.state = "Group Show";
                msg += " is in a group show";
            } else if (bestSession.vs === mfc.STATE.Private) {
                if (bestSession.truepvt === 1) {
                    streamer.state = "True Private";
                    msg += " is in a true private show.";
                } else {
                    streamer.state = "Private";
                    msg += " is in a private show.";
                }
            } else if (bestSession.vs === mfc.STATE.Away) {
                streamer.state = "Away";
                msg += " is away.";
            } else if (bestSession.vs === mfc.STATE.Online) {
                streamer.state = "Away";
                msg += colors.name("'s") + " stream is off.";
            } else if (bestSession.vs === mfc.STATE.Offline) {
                streamer.state = "Offline";
                msg += " has logged off.";
            }

            super.checkStreamerState(streamer, msg, isStreaming, prevState);
            this.render();

            return true;
        }).catch((err) => {
            this.errMsg(err.toString());
            return false;
        });
    }

    getStreamers(bundle) {
        if (!super.getStreamers(bundle)) {
            return Promise.try(() => []);
        }

        const queries = [];
        this.streamersToCap = [];

        for (let i = 0; i < this.siteConfig.streamers.length; i++) {
            queries.push(this.checkStreamerState(this.siteConfig.streamers[i]));
        }

        // Only add a streamer from temp list if they are not
        // in the primary list.  Prevents duplicate recording.
        for (let i = 0; i < this.tempList.length; i++) {
            if (!_.contains(this.siteConfig.streamers, this.tempList[i])) {
                queries.push(this.checkStreamerState(this.tempList[i]));
            }
        }

        return Promise.all(queries).then(() => this.streamersToCap);
    }

    setupCapture(model) {
        if (!super.setupCapture(model.uid)) {
            const empty = {spawnArgs: "", filename: "", streamer: ""};
            return Promise.try(() => empty);
        }

        return Promise.try(() => {
            const filename = this.getFileName(model.nm);
            const mod = mfc.Model.getModel(model.uid);
            const url = this.mfcGuest.getHlsUrl(mod);
            const spawnArgs = this.getCaptureArguments(url, filename);

            return {spawnArgs: spawnArgs, filename: filename, streamer: model};
        }).catch((err) => {
            this.errMsg(colors.name(model.nm) + " " + err.toString());
            return err;
        });
    }
}

exports.Mfc = Mfc;

