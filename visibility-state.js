const State = {
  VISIBLE: 'visible',
  POSTPONED: 'postponed',
  DISMISSED: 'dismissed',
};

class VisibilityState {

  constructor(pref) {
    this.pref = pref;
    this.init(Prefs.getJSON(this.pref));
  }

  init(payload) {
    this.state = payload.state || State.VISIBLE;
    this.timestamp = payload.timestamp || null;
    this.actionTimestamp = payload.actionTimestamp || null;
  }

  remindTomorrow() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    this.remindLater(tomorrow);
  }

  remindInTwoWeeks() {
    const afterTwoWeeks = new Date();    
    afterTwoWeeks.setDate(tomorrow.getDate() + 14);
    afterTwoWeeks.setHours(0, 0, 0, 0);
    this.remindLater(afterTwoWeeks);
  }

  remindLater(timestamp) {
    this.state = State.POSTPONED;
    this.timestamp = timestamp;
    this.actionTimestamp = Date.now();
    this.persist();
  }

  dismissIndefinitely() {
    this.state = State.DISMISSED;
    this.timestamp = null;
    this.actionTimestamp = Date.now();
    this.persist();
  }

  persist() {
    const payload = {
      state: this.state,
      timestamp: this.timestamp,
      actionTimestamp: this.actionTimestamp,
    };
    Prefs.setJSON(this.pref, JSON.stringify(payload));
  }

  get isVisible() {
    return this.state === State.VISIBLE
        || this.state === State.POSTPONED && Date.now() > this.timestamp;
  }

  get isPostponed() {
    return this.state === State.POSTPONED;
  }
}

const state = VisibilityState(Prefs.AMAZON_VISIBILITY_STATE);

const remindLater = () => {
  state.remindTomorrow();
}

const dontShowAgain = () => {
  if (state.isPostponed) {
    state.dismissIndefinitely();
  } else {
    state.remindInTwoWeeks();
  }
};
