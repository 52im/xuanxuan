import Chat from '../../models/chat';
import ChatMessage from '../../models/chat-message';
import profile from '../profile';
import Events from '../events';
import members from '../members';
import db from '../db';
import notice from '../notice';
import DelayAction from '../utils/delay-action';
import StringHelper from '../../utils/string-helper';

const CHATS_LIMIT_DEFAULT = 100;
const MAX_RECENT_TIME  = 1000*60*60*24*7;
const SEARCH_SCORE_MAP = {
    matchAll   : 100,
    matchPrefix: 75,
    include    : 50,
    similar    : 10
};
let chats = null;
let publicChats = null;

const forEach = (callback) => {
    if(chats) {
        Object.keys(chats).forEach(gid => {
            callback(chats[gid]);
        });
    }
};

const get = (gid) => {
    let chat = chats[gid];
    if(!chat && gid.includes('&')) {
        const members = gid.split('&').map(x => Number.parseInt(x));
        chat = new Chat({
            gid,
            members,
            createdBy: profile.user.account,
            type: Chat.TYPES.one2one
        });
        chat.updateMembersSet(members);
    }
    return chat;
};

const updateChatNotice = new DelayAction(() => {
    let total = 0;
    forEach(chat => {
        if(chat.noticeCount) {
            total += chat.noticeCount;
        }
    });
    notice.emit({chats: total});
});

const updateChatMessages = (messages, muted) => {
    if(!Array.isArray(messages)) {
        messages = [messages];
    }
    let chatsMessages = {};
    let messagesForUpdate = [];
    messages.forEach(message => {
        message = ChatMessage.create(message);
        messagesForUpdate.push(message);

        if(!chatsMessages[message.cgid]) {
            chatsMessages[message.cgid] = [message];
        } else {
            chatsMessages[message.cgid].push(message);
        }
    });

    let chats = {};
    Object.keys(chatsMessages).forEach(cgid => {
        const chat = get(cgid);
        if(chat) {
            chat.addMessages(chatsMessages[cgid]);
            if(muted) {
                chat.muted();
            }
            chats[cgid] = chat;
        }
    });

    updateChatNotice.do();

    // Save messages to database
    if(messagesForUpdate.length) {
        return db.database.chatMessages.bulkPut(messagesForUpdate.map(x => x.plain()));
    } else {
        return Promise.resolve(0);
    }
};

const deleteLocalMessage = (message) => {
    if(message.id) {
        return Promise.reject('Cannot delete a remote chat message.');
    }
    const chat = get(message.cgid);
    chat.removeMessage(message.gid);
    Events.emitDataChange({chats: {[chat.gid]: chat}});
    return db.database.chatMessages.delete(gid);
};

const loadChatMessages = (chat, queryObject, limit = CHATS_LIMIT_DEFAULT) => {
    const gid = chat.gid;
    queryObject = queryObject ? Object.assign({gid}, queryObject) : {gid};
    const collection =  db.database.chatMessages.where(queryObject);
    if(limit) {
        collection = collection.limit(limit);
    }
    return collection.toArray(chatMessages => {
        if(chatMessages && chatMessages.length) {
            const result = chatMessages.map(ChatMessage.create);
            if(!queryObject) {
                chat.addMessages(result, true);
                Events.emitDataChange({chats: {[chat.gid]: chat}});
            }
            return Promise.resolve(result);
        } else {
            return Promise.resolve([]);
        }
    });
};

const update = (chatArr) => {
    if(!chatArr) return;

    if(!Array.isArray(chatArr)) {
        chatArr = [chatArr];
    }

    if(!chatArr.length) return;

    let newchats = {};
    chatArr.forEach(chat => {
        chat = Chat.create(chat);
        newchats[chat.gid] = chat;
    });
    Object.assign(chats, newchats);
    Events.emitDataChange({chats: newchats});
};

const init = (chatArr) => {
    chats = {};
    if(chatArr && chatArr.length) {
        update(chatArr);
        forEach(chat => {
            if(!chat.hasSetMessages) {
                loadChatMessages(chat);
            }
        });
    }
};

const getAll = () => {
    return chats ? Object.keys(chats).map(x => chats[x]) : [];
};

const query = (condition, sortList, app) => {
    if(!chats) {
        return [];
    }
    let result = null;
    if(typeof condition === 'object') {
        let conditionObj = condition;
        let conditionKeys = Object.keys(conditionObj);
        condition = chat => {
            for(let key of conditionKeys) {
                if(conditionObj[key] !== chat[key]) {
                    return false;
                }
            }
            return true;
        };
    }
    if(typeof condition === 'function') {
        result = [];
        forEach(chat => {
            if(condition(chat)) {
                result.push(chat);
            }
        });
    } else if(Array.isArray(condition)) {
        result = [];
        condition.forEach(x => {
            const chat = get(x);
            if(chat) {
                result.push(chat);
            }
        });
    } else {
        result = getAll();
    }
    if(sortList && result && result.length) {
        Chat.sort(result, sortList, app);
    }
    return result || [];
};


const getRecents = (includeStar = true) => {
    const all = getAll();
    if(all.length < 2) {
        return all;
    }
    const now = new Date().getTime();
    return all.filter(chat => {
        return chat.noticeCount || (includeStar && chat.star) || (chat.lastActiveTime && (now - chat.lastActiveTime) <= MAX_RECENT_TIME);
    });
};

const getContactChat = (member) => {
    let members = [member.id, profile.user.id].sort();
    const gid = members.join('&');
    let chat = get(gid);
    if(chat) {
        return chat;
    }
    chat = new Chat({
        gid,
        members,
        createdBy: profile.user.account,
        type: 'one2one'
    });
    update(chat);
    return chat;
};

const getContactsChats = () => {
    let contactsChats = [];
    members.forEach(member => {
        if(member.id !== profile.user.id) {
            contactsChats.push(getContactChat(member, true));
        }
    });
    update(contactsChats);
    return contactsChats;
};

const getGroups = () => {
    return query(chat => chat.isGroupOrSystem);
};

const search = (search, chatType) => {
    if(StringHelper.isEmpty(search)) {
        return [];
    }
    search = search.trim().toLowerCase().split(' ');
    if(!search.length) {
        return [];
    }

    const hasChatType = !!chatType;

    if(!hasChatType || chatType === 'contact') {
        getContactsChats();
    }

    let result = [];
    let caculateScore = (sKey, findIn) => {
        if(StringHelper.isEmpty(sKey) || StringHelper.isEmpty(findIn)) {
            return 0;
        }
        if(sKey === findIn) {
            return SEARCH_SCORE_MAP.matchAll;
        }
        let idx = findIn.indexOf(sKey);
        return idx === 0 ? SEARCH_SCORE_MAP.matchPrefix : (idx > 0 ? SEARCH_SCORE_MAP.include : 0);
    };

    return query(chat => {
        const chatGid = chat.gid.toLowerCase();
        if(hasChatType) {
            if((chatType === 'contact' && !chat.isOne2One) || (chatType === 'group' && !chat.isGroupOrSystem)) {
                return;
            }
        }

        let score = 0;
        const imApp = {
            members,
            user: profile.user
        };
        let chatName = chat.getDisplayName(imApp, false).toLowerCase();
        let pinYin = chat.getPinYin(imApp);
        let theOtherOneAccount = '';
        let theOtherOneContactInfo = '';
        if(chat.isOne2One) {
            let theOtherOne = chat.getTheOtherOne(imApp);
            if(theOtherOne) {
                theOtherOneAccount = theOtherOne.account;
                theOtherOneContactInfo += (theOtherOne.email || '') + (theOtherOne.mobile || '');
            } else {
                if(DEBUG) console.warn('Cannot get the other one of chat', chat);
            }
        }
        search.forEach(s => {
            if(StringHelper.isEmpty(s)) {
                return;
            }
            if(s.length > 1) {
                if(s[0] === '#') { // id
                    s = s.substr(1);
                    score += 2*caculateScore(s, chatGid);
                    if(chat.isSystem || chat.isGroup) {
                        score += 2*caculateScore(s, chatName);
                        if(chat.isSystem) {
                            score += 2*caculateScore(s, 'system');
                        }
                    }
                } else if(s[0] === '@') { // account or username
                    s = s.substr(1);
                    if(chat.isOne2One) {
                        score += 2*caculateScore(s, theOtherOneAccount);
                    }
                }
            }
            score += caculateScore(s, chatName);
            score += caculateScore(s, pinYin);
            if(theOtherOneContactInfo) {
                score += caculateScore(s, theOtherOneContactInfo);
            }
        });
        chat.score = score;
        return score > 0;
    }, ((x, y) => x.score - y.score));

    Object.keys(this.dao.chats).forEach(gid => {
        let chat = this.dao.chats[gid];

        if(hasChatType)
        {
            if((chatType === 'contact' && !chat.isOne2One) || (chatType === 'group' && !chat.isGroupOrSystem)) return;
        }

        let score = 0;
        let chatGid = chat.gid.toLowerCase();
        let chatName = chat.getDisplayName(this.$app, false).toLowerCase();
        let pinYin = chat.getPinYin(this.$app);
        let theOtherOneAccount = '';
        let theOtherOneContactInfo = '';
        if(chat.isOne2One) {
            let theOtherOne = chat.getTheOtherOne(this.user);
            if(theOtherOne) {
                theOtherOneAccount = theOtherOne.account;
                theOtherOneContactInfo += (theOtherOne.email || '') + (theOtherOne.mobile || '');
            } else {
                if(DEBUG) console.warn('Cannot get the other one of chat', chat);
            }
        }
        search.forEach(s => {
            if(!s.length) return;
            if(s.length > 1) {
                if(s[0] === '#') { // id
                    s = s.substr(1);
                    score += 2*caculateScore(s, chatGid);
                    if(chat.isSystem || chat.isGroup) {
                        score += 2*caculateScore(s, chatName);
                        if(chat.isSystem) {
                            score += 2*caculateScore(s, 'system');
                        }
                    }
                } else if(s[0] === '@') { // account or username
                    s = s.substr(1);
                    if(chat.isOne2One) {
                        score += 2*caculateScore(s, theOtherOneAccount);
                    }
                }
            }
            score += caculateScore(s, chatName);
            score += caculateScore(s, pinYin);
            if(theOtherOneContactInfo) {
                score += caculateScore(s, theOtherOneContactInfo);
            }
        });
        chat.$.score = score;
        if(score > 0) {
            result.push(chat);
        }
    });
    return result.sort((x, y) => x.$.score - y.$.score);
};

const remove = gid => {
    if(chats[gid]) {
        delete chats[gid];
        return true;
    } else {
        return false;
    }
};

const getChatFiles = (chat, includeFailFile = false) => {
    return getChatFiles(chat, {contentType: 'file'}, 0).then(fileMessages => {
        let files = null;
        if(fileMessages && fileMessages.length) {
            if(includeFailFile) {
                files = fileMessages.map(fileMessage => fileMessage.fileContent);
            } else {
                files = [];
                fileMessages.forEach(fileMessage => {
                    const fileContent = fileMessage.fileContent;
                    if(fileContent.send === true && fileContent.id) {
                        files.push(fileContent);
                    }
                });
            }
        }
        return Promise.resolve(files || []);
    });
};

const getPublicChats = () => {
    return publicChats || [];
};

const updatePublicChats = (serverPublicChats) => {
    publicChats = [];
    if(serverPublicChats) {
        if(!Array.isArray(serverPublicChats)) {
            serverPublicChats = [serverPublicChats];
        }
        if(serverPublicChats.length) {
            serverPublicChats.forEach(chat => {
                chat = Chat.create(chat);
                publicChats.push(chat);
            });
        }
    }
    Events.emitDataChange({publicChats});
};

const createWithMembers = (chatMembers, chatSetting) => {
    if(!Array.isArray(chatMembers)) {
        chatMembers = [chatMembers];
    }
    const userMeId = profile.user.id;
    chatMembers = chatMembers.map(member => {
        if(typeof member === 'object') {
            return member.id;
        } else {
            return member;
        }
    });
    if(!chatMembers.find(memberId => memberId === userMeId)) {
        chatMembers.push(userMeId);
    }
    let chat = null;
    if(chatMembers.length === 2) {
        const gid = chatMembers.sort().join('&');
        chat = get(gid);
        if(!chat) {
            chat= new Chat(Object.assign({
                members: chatMembers,
                createdBy: profile.user.account
            }, chatSetting));
        }
    } else {
        chat= new Chat(Object.assign({
            members: chatMembers,
            createdBy: profile.user.account
        }, chatSetting));
    }
    return chat;
};

profile.onSwapUser(user => {
    init();
});

Events.onDataChange(data => {
    if(data.chats) {
        update(data.chats);
    }
});

export default {
    init,
    update,
    get,
    getAll,
    getRecents,
    forEach,
    query,
    remove,
    getChatMessages,
    getChatFiles,
    deleteLocalMessage,
    loadChatMessages,
    updateChatMessages,
    getPublicChats,
    updatePublicChats,
    createWithMembers,
};
