var fs = require('fs');
var d3 = require('d3');
var jsdom = require('jsdom');
var doc = jsdom.jsdom();
var express = require('express');
var util = require('util');
var cmd = require('node-cmd');
var mongoose = require('mongoose');
var assert = require('assert');
var crypto = require('crypto');
var defaultValues = require('./defaultValues');
var config = require('./config');

var router = express.Router();


/* GET piechart page. */
router.get('/piechart', function(req, res) {

    /** Starts the timer to know how long it takes to execute the request
     *
     */
    console.time('piechart');


    /** Get parameters
     * 
     * @param file Path to file
     * @param colSelected Column selected for the axis
     * @param colCount Column that count values
     * @param opVal Operation to apply
     *
     */
    var file = req.query.file;
    var colSelected = req.query.colSelected;
    var colCount = req.query.colCount;
    var opVal = req.query.opVal || defaultValues.piechart.opVal;
    var sizeFile = req.query.sizeFile;


    /** Init id_plot and create status in Mongo database
     *
     */
    var mongodbURL = config.mongo.connection;
    mongodbURL = mongodbURL.concat(config.mongo.port, "/");
    var mongodbURLDatabase = mongodbURL.concat(config.mongo.database);
    mongoose.Promise = global.Promise;
    var option = {
        server: {
            socketOptions: {
                keepAlive: 300000,
                connectTimeoutMS: 30000
            }
        },
        replset: {
            socketOptions: {
                keepAlive: 300000,
                connectTimeoutMS: 30000
            }
        }
    };
    var db = mongoose.createConnection(mongodbURLDatabase, option);


    /* Insert the status of the graph in MongoDB
     *
     */
    var fileMD5 = crypto.createHash('md5').update(file).digest('hex');
    var sizMD5 = crypto.createHash('md5').update(sizeFile.toString()).digest('hex');
    var plotMD5 = crypto.createHash('md5').update('piechart').digest('hex');
    var auxParamMD5 = colSelected.concat(";", colCount, ";", opVal);
    var paramMD5 = crypto.createHash('md5').update(auxParamMD5).digest('hex');
    var idPlot = fileMD5 + sizMD5 + plotMD5 + paramMD5;

    var statusSchema = new mongoose.Schema({
        id_plot: String,
        status: String,
        date_start: Date,
        date_end: Date
    });
    var MongoStatus = db.model('Status', statusSchema, config.mongo.collectionStatus);


    function sleep(time, callback) {
        var stop = new Date().getTime();
        while (new Date().getTime() < stop + time) {}
        callback();
    }

    MongoStatus.find({
        "id_plot": idPlot
    }, function(err, statusFinded) {
        if (err) return console.error(err);


        if (statusFinded.length != 0) { // If it was previously loaded

            var Result = db.model('Result', new mongoose.Schema({}), config.mongo.collectionResult);
            if (statusFinded[0].status == "run") {
                function isLoadedData(fin) {
                    if (!fin) {
                        sleep(2000, function() {});
                        Result.find({
                            "id_plot": idPlot
                        }, function(err, dataMongo) {
                            if (dataMongo.length === 0) {
                                isLoadedData(false);
                            } else {
                                isLoadedData(true);
                            }
                        });
                    } else {
                        Result.find({
                            "id_plot": idPlot
                        }, function(err, dataMongo) {
                            if (err) return console.error(err);
                            res.send(get_piechart(JSON.stringify(dataMongo[0])).node().outerHTML);
                            db.close(function() {
                                //console.log('Mongoose connection disconnected');
                            });
                            delete db.models['Result'];
                        });
                    }
                }

                isLoadedData(false);

            } else {
                Result.find({
                    "id_plot": idPlot
                }, function(err, dataMongo) {
                    if (err) return console.error(err);
                    res.send(get_piechart(JSON.stringify(dataMongo[0])).node().outerHTML);
                    db.close(function() {
                        //console.log('Mongoose connection disconnected');
                    });
                    delete db.models['Result'];
                });
            }

        } else { // If it was not previously loaded
            var data = [{
                'id_plot': idPlot,
                'status': 'run',
                'date_start': new Date(),
                'date_end': new Date()
            }];


            MongoStatus.collection.insertMany(data, function(err, r) {
                assert.equal(null, err);
                assert.equal(1, r.insertedCount);
            });

            /** Launch spark-submit to generate JSON data for piechart
             * 
             */
            var Result = db.model('Result', new mongoose.Schema({}), config.mongo.collectionResult);
            if (config.api.exec_mode == "systemcall") {
                var submit = config.api.submitSpark;
                submit = submit.concat(defaultValues.piechart.path, ' "', mongodbURL, '" ', ' "', config.mongo.database, '" ', ' "', config.mongo.collectionResult, '" ', ' "', file, '" "', idPlot, '" "', colSelected, '" "', colCount, '" ', opVal);
                cmd.run(submit);

                function getResultAndSend(fin) {
                    if (!fin) {
                        sleep(2000, function() {});
                        Result.find({
                            "id_plot": idPlot
                        }, function(err, dataMongo) {
                            if (dataMongo.length === 0) {
                                getResultAndSend(false);
                            } else {
                                getResultAndSend(true);
                            }
                        });
                    } else {
                        Result.find({
                            "id_plot": idPlot
                        }, function(err, dataMongo) {
                            res.send(get_piechart(JSON.stringify(dataMongo[0])).node().outerHTML);
                            db.close(function() {
                                //console.log('Mongoose connection disconnected');
                            });
                            delete db.models['Result'];
                        });

                        /* Update the status of the graph in MongoDB
                         *
                         */
                        MongoStatus.update({
                                'id_plot': idPlot
                            }, {
                                status: 'finish',
                                date_end: new Date()
                            },
                            function(err, dataNum) {
                                // Get err
                            }
                        );

                        /** Ends the timer to know how long it took to execute the request
                         *
                         */
                        var access = fs.createWriteStream('./graphicRegister/piechart.time.log', {
                            flags: 'a',
                            autoClose: true
                        });
                        process.stdout.write = process.stderr.write = access.write.bind(access);
                        console.timeEnd('piechart');
                        console.log('File: ' + file);
                        console.log('ColSelected: ' + colSelected);
                        console.log('ColCount: ' + colCount);
                        console.log('OpVal: ' + opVal);
                        console.log('Size: ' + sizeFile);
                        console.log('');
                    }
                }

                getResultAndSend(false);





                // cmd.get(
                //     submit,
                //     function(data, err, stderr){
                //         if (!err){
                //             Result.find({"id_plot" : idPlot}, function(err, dataMongo){
                //                 if (err) return console.error(err);
                //                 if(dataMongo.length === 1){
                //                     res.send(get_piechart(JSON.stringify(dataMongo[0])).node().outerHTML);
                //                 }else{
                //                     res.send("Data could not be recovered. Try it again later, please.");
                //                 }
                //                 db.close(function () {
                //                     console.log('Mongoose connection disconnected');
                //                 });
                //                 delete db.models['Result'];
                //             });

                //             /* Update the status of the graph in MongoDB
                //             *
                //             */
                //             MongoStatus.update({'id_plot' : idPlot},
                //               {status : 'finish', date_end: new Date()},
                //               function(err, dataNum){
                //                 // Get err
                //               }
                //             );

                //             /** Ends the timer to know how long it took to execute the request
                //             *
                //             */
                //             var access = fs.createWriteStream('./graphicRegister/piechart.time.log', { flags: 'a', autoClose: true });
                //             process.stdout.write = process.stderr.write = access.write.bind(access);
                //             console.timeEnd('piechart');
                //             console.log('File: ' + file);
                //             console.log('ColSelected: ' + colSelected);
                //             console.log('ColCount: ' + colCount);
                //             console.log('OpVal: ' + opVal);
                //             console.log('Size: ' + sizeFile);
                //             console.log('');


                //         }else{
                //             res.send(err);
                //         }
                //     }
                // );


            } else {

            }
        }
    });
});





function get_piechart(dataJSON) {

    var json = JSON.parse(dataJSON);

    var width = 960,
        height = 500,
        radius = Math.min(width, height) / 2;

    var color = d3.scale.category20();

    var pie = d3.layout.pie()
        .sort(null)
        .value(function(d) {
            return d.colValue;
        });

    var path = d3.svg.arc()
        .outerRadius(radius - 10)
        .innerRadius(0);

    var label = d3.svg.arc()
        .outerRadius(radius - 40)
        .innerRadius(radius - 40);

    var svgContainer = d3.select(doc.body)
        .append("div")
        .classed("svg-container", true)
        .append("svg")
        .attr("preserveAspectRatio", "xMinYMin meet")
        .attr("viewBox", "-400 -300 1024 768")
        .classed("svg-content-responsive", true);
    var svg = svgContainer;

    var arc = svg.selectAll(".arc")
        .data(pie(json.lvalues))
        .enter().append("g")
        .attr("class", "arc");

    arc.append("path")
        .attr("d", path)
        .style("fill", function(d) {
            return color(d.data.colKey);
        });

    arc.append("text")
        .attr("transform", function(d) {
            return "translate(" + label.centroid(d) + ")";
        })
        .attr("dy", "0.35em")
        .text(function(d) {
            return d.data.colValue;
        });

    var legendG = svg.selectAll(".legend")
        .data(pie(json.lvalues))
        .enter().append("g")
        .attr("transform", function(d, i) {
            return "translate(" + 370 + "," + (i * 15 - 200) + ")";
        })
        .attr("class", "legend");

    legendG.append("rect")
        .attr("width", 20)
        .attr("height", 10)
        .style("fill", function(d, i) {
            return color(d.data.colKey);
        });


    legendG.append("text")
        .text(function(d) {
            return d.data.colKey;
        })
        .style("font-size", 12)
        .attr("y", 10)
        .attr("x", 25);





    return svgContainer;
};



module.exports = router;