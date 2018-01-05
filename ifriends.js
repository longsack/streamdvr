const Promise      = require("bluebird");
const colors       = require("colors/safe");
const fetch        = require("node-fetch");
const childProcess = require("child_process");
const site         = require("./site");

class IFriends extends site.Site {
    constructor(config, tui) {
        super("IFRIENDS", config, "_ifriends", tui);

        for (let i = 0; i < this.siteConfig.streamers.length; i++) {
            const nm = this.siteConfig.streamers[i];
            this.streamerList.set(nm, {uid: nm, nm: nm, state: "Offline", filename: "", captureProcess: null});
        }
    }

    updateList(nm, add, isTemp) {
        return Promise.try(() => super.updateList({nm: nm, uid: nm}, add, isTemp));
    }

    checkStreamerState(nm) {
        const url = "https://www.ifriends.net/userurl_membrg/live/?psource=lbgrid_altlivebutton10_v2&pclub=" + nm;

        return Promise.try(() => fetch(url)).then((res) => res.text()).then((text) => {
            const streamer = this.streamerList.get(nm);
            const prevState = streamer.state;

            let isStreaming = 0;
            let msg = colors.name(nm);

            if (text) {
                msg += " is offline.";
                streamer.state = "Offline";
            } else {
                msg += " is streaming.";
                this.streamersToCap.push({uid: nm, nm: nm});
                isStreaming = 1;
                streamer.state = "Streaming";
            }

            super.checkStreamerState(streamer, msg, isStreaming, prevState);

            this.render();
            return true;
        }).catch((err) => {
            this.errMsg(colors.name(nm), " lookup problem: " + err.toString());
            return false;
        });
    }

    getStreamers(bundle) {
        if (!super.getStreamers(bundle)) {
            return Promise.try(() => []);
        }

        const queries = [];
        this.streamersToCap = [];

        this.streamerList.forEach((value) => {
            queries.push(this.checkStreamerState(value.nm));
        });

        return Promise.all(queries).then(() => this.streamersToCap);
    }

    setupCapture(streamer) {
        if (!super.setupCapture(streamer.uid)) {
            const empty = {spawnArgs: "", filename: "", streamer: ""};
            return Promise.try(() => empty);
        }

        return Promise.try(() => {
            const filename = this.getFileName(streamer.nm);
            let url = childProcess.execSync("youtube-dl -g https://twitch.tv/" + streamer.nm);

            url = url.toString();
            url = url.replace(/\r?\n|\r/g, "");

            const spawnArgs = this.getCaptureArguments(url, filename);

            return {spawnArgs: spawnArgs, filename: filename, streamer: streamer};
        });
    }
}

exports.IFriends = IFriends;

